import { getEnv } from "@furan/config";
import { createDb, projects } from "@furan/db";
import {
  createRedisConnection,
  createWorker,
  isFinalAttempt,
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
    service: "capture-worker",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });
  installProcessErrorHandlers(telemetry.logger);

  const { db, close: closeDb } = createDb();
  const storage = createStorage(telemetry.metrics);
  const redis = createRedisConnection();

  const worker = createWorker(
    "capture",
    async (job) => {
      telemetry.logger.info(
        { jobId: job.id, projectId: job.data.projectId },
        "capture_job_received",
      );
      // Only the final attempt may mark the run `aborted` (ruling R10); an
      // earlier failure is retried by BullMQ and the retry carries on.
      return handleCaptureJob(
        job.data,
        telemetry.logger,
        {
          db,
          storage,
          redis,
          blockPrivateIps: env.CAPTURE_BLOCK_PRIVATE_IPS,
        },
        { finalAttempt: isFinalAttempt(job) },
      );
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
    // Deep readiness: a worker that can't reach Redis (its job source) or
    // Postgres would report ready while silently failing every dequeue. Probe
    // both under a short timeout; any failure → not_ready so an orchestrator
    // stops routing to / restarts this pod. Never throws (the health handler
    // awaits this) — a failed probe resolves to false.
    ready: async () => {
      if (!worker.isRunning()) return false;
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
