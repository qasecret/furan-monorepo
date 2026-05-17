import { createHmac } from "node:crypto";

import type { DB } from "@furan/db";
import { describe, expect, test, vi } from "vitest";

import {
  deliver,
  type DeliveryDeps,
  type DeliveryJob,
  type FetchFn,
} from "../src/webhooks/delivery.js";

interface FakeWebhookRow {
  id: string;
  url: string;
  secret: string | null;
  active: boolean;
  projectId: string;
}

/**
 * Build a tiny in-memory shim with just enough surface to satisfy
 * `delivery.ts`. The contract under test is:
 *   - `db.query.webhooks.findFirst({ where: eq(...) })`  → returns the row
 *   - `db.insert(webhookDeliveries).values(row)`         → records the attempt
 *   - `db.update(webhooks).set(...).where(...)`          → mirrors last-status
 *
 * We don't care about the exact drizzle types here — the integration test
 * lives in a follow-on. This unit test pins the retry/DLQ logic.
 */
function fakeDb(rows: FakeWebhookRow[]): {
  db: DB;
  inserted: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];

  const stub = {
    query: {
      webhooks: {
        findFirst: vi.fn(async () => rows[0]),
      },
    },
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
      },
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => ({
        where: async () => {
          updates.push(row);
        },
      }),
    }),
  } as unknown as DB;

  return { db: stub, inserted, updates };
}

function buildDeps(
  fetchFn: FetchFn,
  rows: FakeWebhookRow[],
  overrides: Partial<DeliveryDeps> = {},
): {
  deps: DeliveryDeps;
  inserted: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const { db, inserted, updates } = fakeDb(rows);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  } as unknown as DeliveryDeps["logger"];

  return {
    deps: {
      db,
      logger,
      fetch: fetchFn,
      backoffMs: [0, 0, 0, 0, 0],
      sleep: async () => undefined,
      now: () => new Date("2026-05-17T00:00:00Z"),
      ...overrides,
    },
    inserted,
    updates,
  };
}

const SAMPLE_WEBHOOK: FakeWebhookRow = {
  id: "00000000-0000-0000-0000-000000000001",
  url: "https://example.com/hook",
  secret: "shh",
  active: true,
  projectId: "proj-1",
};

const SAMPLE_JOB: DeliveryJob = {
  webhookId: SAMPLE_WEBHOOK.id,
  event: "run.completed",
  payload: { runId: "r1", status: "passed" },
};

describe("deliver", () => {
  test("200 OK marks delivered after 1 attempt with HMAC header", async () => {
    const fetchFn = vi.fn(async () => ({ status: 200 })) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [SAMPLE_WEBHOOK]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out).toEqual({ status: "delivered", attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { headers: Record<string, string>; body: string }];
    const [url, init] = call;
    expect(url).toBe(SAMPLE_WEBHOOK.url);
    expect(init.headers["X-Furan-Event"]).toBe("run.completed");
    expect(init.headers["User-Agent"]).toBe("furan-webhook/0.5.0");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["X-Furan-Delivery"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}/,
    );

    const expectedSig =
      "sha256=" + createHmac("sha256", "shh").update(init.body).digest("hex");
    expect(init.headers["X-Furan-Signature"]).toBe(expectedSig);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe("delivered");
    expect(inserted[0].attempts).toBe(1);
    expect(inserted[0].lastError).toBeNull();
  });

  test("404 marks DLQ immediately after 1 attempt with lastError HTTP 404", async () => {
    const fetchFn = vi.fn(async () => ({ status: 404 })) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [SAMPLE_WEBHOOK]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out).toEqual({ status: "dlq", attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(inserted[0].status).toBe("dlq");
    expect(inserted[0].lastError).toBe("HTTP 404");
  });

  test("429 retries up to 5 attempts then DLQ", async () => {
    const fetchFn = vi.fn(async () => ({ status: 429 })) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [SAMPLE_WEBHOOK]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out).toEqual({ status: "dlq", attempts: 5 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(inserted[0].status).toBe("dlq");
    expect(inserted[0].lastError).toBe("HTTP 429");
  });

  test("500 retries up to 5 attempts then DLQ", async () => {
    const fetchFn = vi.fn(async () => ({ status: 500 })) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [SAMPLE_WEBHOOK]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out).toEqual({ status: "dlq", attempts: 5 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(inserted[0].lastError).toBe("HTTP 500");
  });

  test("network error retries up to 5 attempts then DLQ", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [SAMPLE_WEBHOOK]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out).toEqual({ status: "dlq", attempts: 5 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(inserted[0].lastError).toBe("ECONNREFUSED");
  });

  test("500 then 200 on attempt 2 delivers in 2 attempts", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n++;
      return n === 1 ? { status: 500 } : { status: 200 };
    }) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [SAMPLE_WEBHOOK]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out).toEqual({ status: "delivered", attempts: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(inserted[0].status).toBe("delivered");
    expect(inserted[0].attempts).toBe(2);
  });

  test("inactive webhook → DLQ without fetching", async () => {
    const fetchFn = vi.fn(async () => ({ status: 200 })) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [
      { ...SAMPLE_WEBHOOK, active: false },
    ]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out.status).toBe("dlq");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(inserted[0].lastError).toBe("inactive");
  });

  test("webhook with null secret → DLQ without fetching", async () => {
    const fetchFn = vi.fn(async () => ({ status: 200 })) as unknown as FetchFn;
    const { deps, inserted } = buildDeps(fetchFn, [
      { ...SAMPLE_WEBHOOK, secret: null },
    ]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out.status).toBe("dlq");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(inserted[0].lastError).toBe("no_secret");
  });

  test("408 Request Timeout is treated as retryable", async () => {
    const fetchFn = vi.fn(async () => ({ status: 408 })) as unknown as FetchFn;
    const { deps } = buildDeps(fetchFn, [SAMPLE_WEBHOOK]);

    const out = await deliver(SAMPLE_JOB, deps);

    expect(out).toEqual({ status: "dlq", attempts: 5 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });
});
