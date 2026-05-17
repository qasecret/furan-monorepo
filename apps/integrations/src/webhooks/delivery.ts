import { randomUUID } from "node:crypto";

import { and, eq, webhookDeliveries, webhooks, type DB } from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import { Counter, type Registry } from "prom-client";

import { signPayload } from "./signer.js";

type Logger = Telemetry["logger"];

/**
 * Backoff schedule per spec §4.3 — 1s, 5s, 30s, 2m, 10m between attempts
 * for retryable failures (5xx, 408, 429, network). Total attempts capped
 * at `BACKOFF_MS.length + 1` (= 6, but spec says "up to 5 retries" → 5
 * elements, so 5 attempts total). Tests inject `[0,0,0,0,0]` via
 * `deps.backoffMs` to avoid real sleeps.
 */
export const BACKOFF_MS: readonly number[] = [
  1_000, 5_000, 30_000, 120_000, 600_000,
];

const MAX_ATTEMPTS = BACKOFF_MS.length; // 5

const RETRYABLE_STATUS = new Set([408, 429]);

/** Body the delivery worker POSTs (and the row it persists). */
export interface DeliveryJob {
  webhookId: string;
  event: string;
  payload: unknown;
}

/** `fetch`-compatible signature, kept narrow so tests can mock without
 * pulling in the global DOM-typed `RequestInit` surface. */
export type FetchFn = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; statusText?: string }>;

export interface DeliveryDeps {
  db: DB;
  logger: Logger;
  fetch: FetchFn;
  /** Test seam: override real sleeps so retry tests run in ms not minutes. */
  backoffMs?: readonly number[];
  /** Optional Counter for DLQ events; tests can omit. */
  dlqCounter?: Counter<string>;
  /** Test seam: clock for `attemptAt` timestamps. */
  now?: () => Date;
  /** Test seam: sleep override. Default uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const USER_AGENT = "furan-webhook/0.5.0";
const TIMEOUT_MS = 10_000;

/**
 * Lazily-built DLQ counter so multiple delivery calls share one series.
 * Exported as a factory for the worker bootstrap to register against the
 * service-wide telemetry registry.
 */
export function createDlqCounter(registry: Registry): Counter<string> {
  return new Counter({
    name: "furan_webhook_dlq_total",
    help: "Outbound webhook deliveries permanently routed to DLQ",
    labelNames: ["event"],
    registers: [registry],
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver one webhook job end-to-end:
 *  1. Look up the webhook row, skip+DLQ defensively if missing/inactive/no-secret.
 *  2. Sign the payload with HMAC-SHA256.
 *  3. POST with retry-with-backoff per `BACKOFF_MS`.
 *  4. Persist a `webhook_deliveries` row with the final status + last error.
 *
 * Pure-DI: `fetch`, `sleep`, `now`, and the DLQ counter are all injectable
 * so the unit tests can run in-memory with mock fetch and zeroed backoff.
 */
export async function deliver(
  job: DeliveryJob,
  deps: DeliveryDeps,
): Promise<{ status: "delivered" | "dlq"; attempts: number }> {
  const backoff = deps.backoffMs ?? BACKOFF_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());

  const hook = await deps.db.query.webhooks.findFirst({
    where: eq(webhooks.id, job.webhookId),
  });

  if (!hook) {
    deps.logger.warn(
      { webhookId: job.webhookId, event: job.event },
      "webhook_delivery_skipped_unknown_webhook",
    );
    deps.dlqCounter?.inc({ event: job.event });
    await recordDelivery(deps.db, {
      webhookId: job.webhookId,
      event: job.event,
      payload: job.payload,
      attempts: 0,
      status: "dlq",
      lastError: "webhook_not_found",
      lastAttemptAt: now(),
    });
    return { status: "dlq", attempts: 0 };
  }

  if (!hook.active) {
    deps.logger.info(
      { webhookId: hook.id, event: job.event },
      "webhook_delivery_skipped_inactive",
    );
    await recordDelivery(deps.db, {
      webhookId: hook.id,
      event: job.event,
      payload: job.payload,
      attempts: 0,
      status: "dlq",
      lastError: "inactive",
      lastAttemptAt: now(),
    });
    deps.dlqCounter?.inc({ event: job.event });
    return { status: "dlq", attempts: 0 };
  }

  if (!hook.secret) {
    deps.logger.warn(
      { webhookId: hook.id, event: job.event },
      "webhook_delivery_skipped_no_secret",
    );
    await recordDelivery(deps.db, {
      webhookId: hook.id,
      event: job.event,
      payload: job.payload,
      attempts: 0,
      status: "dlq",
      lastError: "no_secret",
      lastAttemptAt: now(),
    });
    deps.dlqCounter?.inc({ event: job.event });
    return { status: "dlq", attempts: 0 };
  }

  const bodyText = JSON.stringify(job.payload);
  const signature = signPayload(hook.secret, bodyText);

  let attempts = 0;
  let lastError: string | null = null;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attempts = i + 1;
    const attemptAt = now();
    const deliveryId = randomUUID();
    try {
      const res = await deps.fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "X-Furan-Event": job.event,
          "X-Furan-Signature": `sha256=${signature}`,
          "X-Furan-Delivery": deliveryId,
        },
        body: bodyText,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status >= 200 && res.status < 300) {
        await recordDelivery(deps.db, {
          webhookId: hook.id,
          event: job.event,
          payload: job.payload,
          attempts,
          status: "delivered",
          lastError: null,
          lastAttemptAt: attemptAt,
        });
        deps.logger.info(
          {
            webhookId: hook.id,
            event: job.event,
            attempts,
            status: res.status,
          },
          "webhook_delivered",
        );
        return { status: "delivered", attempts };
      }

      if (
        res.status >= 400 &&
        res.status < 500 &&
        !RETRYABLE_STATUS.has(res.status)
      ) {
        // Non-retryable client error — immediate DLQ.
        lastError = `HTTP ${res.status}`;
        await recordDelivery(deps.db, {
          webhookId: hook.id,
          event: job.event,
          payload: job.payload,
          attempts,
          status: "dlq",
          lastError,
          lastAttemptAt: attemptAt,
        });
        deps.dlqCounter?.inc({ event: job.event });
        deps.logger.warn(
          {
            webhookId: hook.id,
            event: job.event,
            attempts,
            status: res.status,
          },
          "webhook_dlq_non_retryable",
        );
        return { status: "dlq", attempts };
      }

      // Retryable (5xx, 408, 429) → loop with backoff.
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      // Network/timeout error — retryable.
      lastError =
        err instanceof Error ? err.message : `network_error: ${String(err)}`;
    }

    // Backoff before next attempt, unless this was the last attempt.
    if (i < MAX_ATTEMPTS - 1) {
      const delay = backoff[i] ?? 0;
      if (delay > 0) await sleep(delay);
    }
  }

  // Exhausted retries → DLQ.
  await recordDelivery(deps.db, {
    webhookId: hook.id,
    event: job.event,
    payload: job.payload,
    attempts,
    status: "dlq",
    lastError,
    lastAttemptAt: now(),
  });
  deps.dlqCounter?.inc({ event: job.event });
  deps.logger.warn(
    { webhookId: hook.id, event: job.event, attempts, lastError },
    "webhook_dlq_exhausted",
  );
  return { status: "dlq", attempts };
}

interface DeliveryRow {
  webhookId: string;
  event: string;
  payload: unknown;
  attempts: number;
  status: "pending" | "delivered" | "dlq";
  lastError: string | null;
  lastAttemptAt: Date;
}

/**
 * Upsert-ish insert that records the final outcome of one delivery.
 * Append-only by design — each call writes one row. A future "retry from
 * DLQ" UI can read the latest row per (webhookId, event) and re-enqueue.
 *
 * Updates the parent `webhooks` row's `lastDeliveredAt` + `lastStatus`
 * mirror so the project-settings UI can show "last delivery" without a
 * subquery into `webhook_deliveries`.
 */
export async function recordDelivery(db: DB, row: DeliveryRow): Promise<void> {
  await db.insert(webhookDeliveries).values({
    webhookId: row.webhookId,
    event: row.event,
    // jsonb column accepts anything serialisable.
    payload: row.payload as object,
    attempts: row.attempts,
    status: row.status,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt,
  });

  // Best-effort mirror onto parent webhooks row.
  try {
    await db
      .update(webhooks)
      .set({
        lastDeliveredAt: row.lastAttemptAt,
        lastStatus: row.status,
      })
      .where(and(eq(webhooks.id, row.webhookId)));
  } catch {
    // Mirror is decorative — don't fail the delivery on a parent update miss.
  }
}
