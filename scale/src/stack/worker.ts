import { createDb } from "@furan/db";
import { startDiffWorker } from "@furan/diff-worker/runtime";
import { createRedisConnection, type Redis } from "@furan/queue";
import { createStorage } from "@furan/storage";
import { bootstrapTelemetry, type Registry } from "@furan/telemetry";

import { QUEUE_PREFIX, WORKER_CONCURRENCY } from "./constants.js";
import { closeInOrder, type Teardown } from "./teardown.js";

const READY_TIMEOUT_MS = 15_000;

/** Ends a connection: a ready one quits, any other is dropped. */
export async function releaseRedis(redis: Redis): Promise<void> {
  if (redis.status !== "ready") {
    redis.disconnect();
    return;
  }
  await redis.quit().catch(() => redis.disconnect());
}

/**
 * The real diff worker, in this process, with its own pool, connection,
 * storage and metrics registry (as the service has).
 *
 * The reconciler is off: the seed has `running` runs whose last step was never
 * diffed, uploaded long ago, and within 30 s the reconciler would re-queue
 * those steps (and, after 3 windows, fail them with `timeout`), adding diff
 * jobs and changing the shape being measured.
 *
 * Reads `DATABASE_URL`, `REDIS_URL` and the storage settings from
 * `process.env`, so `applyStackEnv` must have run.
 */
export async function startWorker(
  scratchUrl: string,
  teardown: Teardown,
): Promise<{ registry: Registry }> {
  const telemetry = bootstrapTelemetry({
    service: "diff-worker",
    version: "scale",
  });
  const { db, close: closeDb } = createDb({ url: scratchUrl });
  const redis = createRedisConnection();
  const started: { runtime?: ReturnType<typeof startDiffWorker> } = {};
  // One step: the worker drains its in-flight jobs before the pool and the
  // connection under it go. Registered before the worker starts, so a failure
  // while it comes up still closes what was opened.
  teardown.add("close the diff worker", () =>
    closeInOrder(
      async () => started.runtime?.close(),
      () => releaseRedis(redis),
      closeDb,
      telemetry.shutdown,
    ),
  );

  const runtime = (started.runtime = startDiffWorker({
    db,
    storage: createStorage(telemetry.metrics),
    redis,
    logger: telemetry.logger,
    registry: telemetry.metrics,
    queuePrefix: QUEUE_PREFIX,
    concurrency: WORKER_CONCURRENCY,
    reconciler: false,
  }));

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runtime.worker.waitUntilReady(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the diff worker did not become ready")),
          READY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { registry: telemetry.metrics };
}
