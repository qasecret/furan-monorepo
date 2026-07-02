import { getEnv } from "@furan/config";
import { createDb } from "@furan/db";
import {
  createRedisConnection,
  createWorker,
  isTerminalFailure,
} from "@furan/queue";
import { createStorage } from "@furan/storage";
import {
  bootstrapTelemetry,
  Counter,
  installProcessErrorHandlers,
  logStartupFatal,
} from "@furan/telemetry";

import { envSchema } from "./env.js";
import { handleCaptureJob } from "./handler.js";
import { startHealthServer } from "./health.js";
import { closeAllBrowsers } from "./playwright.js";

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "capture-worker",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });
  installProcessErrorHandlers(telemetry.logger);

  const { db, close: closeDb } = createDb();
  const storage = createStorage();
  const redis = createRedisConnection();

  const worker = createWorker(
    "capture",
    async (job) => {
      telemetry.logger.info(
        { jobId: job.id, projectId: job.data.projectId },
        "capture_job_received",
      );
      return handleCaptureJob(job.data, telemetry.logger, {
        db,
        storage,
        redis,
        blockPrivateIps: env.CAPTURE_BLOCK_PRIVATE_IPS,
      });
    },
    { concurrency: env.CAPTURE_CONCURRENCY },
  );

  // Dead-letter signal: a capture that exhausts its retries drops a run's
  // screenshot silently. Surface terminal failures as a metric + error log so
  // an operator alert can fire; transient (will-retry) failures stay at warn.
  const deadLettered = new Counter({
    name: "furan_capture_jobs_dead_lettered_total",
    help: "Capture jobs that exhausted all retries (permanently failed)",
    registers: [telemetry.metrics],
  });
  worker.on("failed", (job, err) => {
    if (isTerminalFailure(job)) {
      deadLettered.inc();
      telemetry.logger.error(
        {
          err,
          jobId: job?.id,
          projectId: job?.data?.projectId,
          attemptsMade: job?.attemptsMade,
        },
        "capture_job_dead_lettered",
      );
    } else {
      telemetry.logger.warn(
        { err, jobId: job?.id, attemptsMade: job?.attemptsMade },
        "capture_job_failed_will_retry",
      );
    }
  });

  const health = startHealthServer({
    port: env.PORT,
    telemetry,
    ready: async () => worker.isRunning(),
  });

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.logger.info({ signal }, "shutting_down");
    await worker.close();
    await closeAllBrowsers();
    redis.disconnect();
    await closeDb();
    await new Promise<void>((res) => health.close(() => res()));
    await telemetry.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  telemetry.logger.info({ port: env.PORT }, "capture_worker_started");
}

void main().catch((err) => {
  logStartupFatal("capture-worker", err);
  process.exit(1);
});
