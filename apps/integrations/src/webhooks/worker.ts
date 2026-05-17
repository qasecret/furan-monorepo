import type { DB } from "@furan/db";
import { createWorker, type Worker } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";
import type { Counter } from "prom-client";

import { deliver, type FetchFn } from "./delivery.js";

type Logger = Telemetry["logger"];

export interface WebhookWorkerDeps {
  db: DB;
  logger: Logger;
  /** Defaults to global `fetch` (Node 22 has it built-in). Test override seam. */
  fetch?: FetchFn;
  dlqCounter?: Counter<string>;
  concurrency?: number;
}

/**
 * Bootstrap the BullMQ worker that drains the `webhook` queue (jobs
 * enqueued by `run-events/subscriber.ts` on `run.completed`).
 *
 * Mirrors the diff-worker bootstrap in `apps/diff-worker/src/server.ts` —
 * `createWorker` is the canonical helper from `@furan/queue`, which wires
 * the BullMQ connection from `REDIS_URL` and types the job payload.
 *
 * Concurrency defaults to 8 (per spec §4.3). Each handler invocation is
 * the full retry-with-backoff lifecycle for ONE webhook, so 8 in-flight
 * is a soft cap on how many slow subscribers we can absorb concurrently
 * before queue depth grows.
 */
export function startWebhookWorker(deps: WebhookWorkerDeps): Worker<{
  projectId: string;
  webhookId: string;
  event: string;
  payload: unknown;
}> {
  const fetchFn = deps.fetch ?? globalFetch();
  const worker = createWorker(
    "webhook",
    async (job) => {
      await deliver(
        {
          webhookId: job.data.webhookId,
          event: job.data.event,
          payload: job.data.payload,
        },
        {
          db: deps.db,
          logger: deps.logger,
          fetch: fetchFn,
          ...(deps.dlqCounter ? { dlqCounter: deps.dlqCounter } : {}),
        },
      );
    },
    { concurrency: deps.concurrency ?? 8 },
  );

  worker.on("failed", (job, err) => {
    deps.logger.error(
      { err, jobId: job?.id, webhookId: job?.data?.webhookId },
      "webhook_worker_job_failed",
    );
  });

  return worker;
}

/**
 * Narrowed wrapper around the global `fetch` to fit `FetchFn`. The Node 22
 * Web Fetch return type carries DOM-leaning fields we don't use; this
 * keeps the worker's surface minimal so the test mock has nothing extra
 * to satisfy.
 */
function globalFetch(): FetchFn {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return { status: res.status, statusText: res.statusText };
  };
}
