import { getEnv } from "@furan/config";
import { createDb } from "@furan/db";
import {
  createRedisConnection,
  createRetentionQueue,
  createWorker,
} from "@furan/queue";
import { createStorage } from "@furan/storage";
import { bootstrapTelemetry } from "@furan/telemetry";

import { createDiffMetrics } from "./diff-metrics.js";
import { envSchema } from "./env.js";
import { handleDiffJob } from "./handler.js";
import { startHealthServer } from "./health.js";
import {
  createRetentionMetrics,
  handleRetentionJob,
} from "./retention-handler.js";

/** Cron pattern for the nightly retention sweep. 3am UTC keeps it well
 *  outside business hours for both NA and EU while leaving wide breathing
 *  room before the next workday begins anywhere. */
const RETENTION_CRON = "0 3 * * *";

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "diff-worker",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });

  const { db, close: closeDb } = createDb();
  const storage = createStorage();
  const redis = createRedisConnection();
  const retentionMetrics = createRetentionMetrics(telemetry.metrics);
  const diffMetrics = createDiffMetrics(telemetry.metrics);

  const worker = createWorker("diff", async (job) => {
    telemetry.logger.info(
      { jobId: job.id, projectId: job.data.projectId },
      "diff_job_received",
    );
    return handleDiffJob(job.data, telemetry.logger, {
      db,
      storage,
      redis,
      metrics: diffMetrics,
    });
  });

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
    ready: async () => worker.isRunning() && retentionWorker.isRunning(),
  });

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.logger.info({ signal }, "shutting_down");
    await worker.close();
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
  console.error(err);
  process.exit(1);
});
