import { getEnv } from "@furan/config";
import { createDb, projects } from "@furan/db";
import {
  createRedisConnection,
  createRetentionQueue,
  createWorker,
} from "@furan/queue";
import { createStorage } from "@furan/storage";
import {
  bootstrapTelemetry,
  installProcessErrorHandlers,
  logStartupFatal,
} from "@furan/telemetry";

import { envSchema } from "./env.js";
import { startHealthServer } from "./health.js";
import {
  createRetentionMetrics,
  handleRetentionJob,
} from "./retention-handler.js";
import { startDiffWorker } from "./runtime.js";

/** Cron pattern for the nightly retention sweep. 3am UTC keeps it well
 *  outside business hours for both NA and EU while leaving wide breathing
 *  room before the next workday begins anywhere. */
const RETENTION_CRON = "0 3 * * *";

/** Bound a readiness dependency check so a hung Redis/Postgres can't hang the
 *  probe. Mirrors the `withTimeout` in the api's health route. */
const PROBE_TIMEOUT_MS = 1000;
function probe<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error("probe_timeout")), PROBE_TIMEOUT_MS),
    ),
  ]);
}

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "diff-worker",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });
  installProcessErrorHandlers(telemetry.logger);

  const { db, close: closeDb } = createDb();
  const storage = createStorage(telemetry.metrics);
  const redis = createRedisConnection();
  const retentionMetrics = createRetentionMetrics(telemetry.metrics);

  // The diff worker, its job metrics, the dead-letter signal and the 30 s
  // reconciler live in `runtime.ts`; the scale harness runs the same
  // code in-process.
  const diffRuntime = startDiffWorker({
    db,
    storage,
    redis,
    logger: telemetry.logger,
    registry: telemetry.metrics,
  });
  const worker = diffRuntime.worker;

  const retentionWorker = createWorker(
    "retention",
    async (job) => {
      telemetry.logger.info(
        {
          jobId: job.id,
          projectIds: job.data.projectIds,
          dryRun: job.data.dryRun,
        },
        "retention_job_received",
      );
      return handleRetentionJob(job.data, telemetry.logger, {
        db,
        redis,
        storage,
        metrics: retentionMetrics,
      });
    },
    // Retention sweeps touch every project sequentially under per-project
    // locks; running multiple in parallel buys nothing and just inflates
    // DB/MinIO load. Keep concurrency at 1.
    { concurrency: 1 },
  );

  // Register the nightly cron at startup. `jobId: "retention-nightly"`
  // makes the registration idempotent across worker restarts — BullMQ
  // dedupes by jobId so we never accumulate duplicate schedules.
  const retentionQueue = createRetentionQueue();
  await retentionQueue.add(
    "retention-nightly",
    {},
    {
      repeat: { pattern: RETENTION_CRON },
      jobId: "retention-nightly",
    },
  );

  const health = startHealthServer({
    port: env.PORT,
    telemetry,
    // Deep readiness: both workers running AND the shared deps (Redis job
    // source + Postgres) reachable under a short timeout. Any failure →
    // not_ready. Never throws (the health handler awaits this).
    ready: async () => {
      if (!worker.isRunning() || !retentionWorker.isRunning()) return false;
      try {
        await Promise.all([
          probe(redis.ping()),
          probe(db.select().from(projects).limit(1)),
        ]);
        return true;
      } catch (err) {
        telemetry.logger.warn({ err }, "readyz_dependency_probe_failed");
        return false;
      }
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.logger.info({ signal }, "shutting_down");
    // Stops the reconciler, then closes the diff worker.
    await diffRuntime.close();
    await retentionWorker.close();
    await retentionQueue.close();
    redis.disconnect();
    await closeDb();
    await new Promise<void>((res) => health.close(() => res()));
    await telemetry.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  telemetry.logger.info(
    { port: env.PORT, retentionCron: RETENTION_CRON },
    "diff_worker_started",
  );
}

void main().catch((err) => {
  logStartupFatal("diff-worker", err);
  process.exit(1);
});
