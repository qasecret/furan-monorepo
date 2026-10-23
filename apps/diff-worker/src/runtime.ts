import type { DB } from "@furan/db";
import {
  createQueue,
  createWorker,
  isFinalAttempt,
  isTerminalFailure,
  type DiffJob,
  type Redis,
  type Worker,
} from "@furan/queue";
import type { Storage } from "@furan/storage";
import { Counter, type Registry, type Telemetry } from "@furan/telemetry";

import { createDiffMetrics, type DiffMetrics } from "./diff-metrics.js";
import { handleDiffJob } from "./handler.js";
import {
  createDiffJobMetrics,
  type DiffJobAttemptOutcome,
} from "./job-metrics.js";
import { registerQueueDepthGauge } from "./queue-depth.js";
import { sweepStaleRuns } from "./sweeper.js";

type Logger = Telemetry["logger"];

/** How often the sweeper looks for stale `running` runs. */
const SWEEP_INTERVAL_MS = 30_000;

export interface DiffWorkerRuntimeOptions {
  db: DB;
  storage: Storage;
  redis: Redis;
  logger: Logger;
  /**
   * The registry every diff metric registers on: the pipeline metrics
   * (`createDiffMetrics`, handed to the handler), the job metrics and the
   * dead-letter counter. The runtime registers them itself, once per registry,
   * so a caller (the service, the scale harness) only supplies the registry.
   */
  registry: Registry;
  /**
   * BullMQ key prefix of the queue this worker consumes. It must equal the
   * prefix the feeding queue was created with. Omit for BullMQ's default.
   */
  queuePrefix?: string;
  /** Jobs processed in parallel. Default 4. */
  concurrency?: number;
  /** Override the job handler. For tests only. */
  handler?: typeof handleDiffJob;
  /**
   * Run the 30 s stale-run sweeper. Default true. The harness turns it off:
   * it would finalize the runs a measurement is still waiting on.
   */
  sweeper?: boolean;
}

export interface DiffWorkerRuntime {
  worker: Worker<DiffJob>;
  /**
   * Stop the sweeper, then close the worker (waits for in-flight jobs) and its
   * queue (the one the depth gauge reads and split jobs are added to), and
   * release the connections both were given.
   * It does not touch `db`, `storage` or `redis`: the caller owns those. Safe
   * to call more than once, and it never waits on a connection that has not
   * become ready.
   */
  close(): Promise<void>;
}

interface RuntimeMetrics {
  diff: DiffMetrics;
  deadLettered: Counter;
}

// prom-client rejects registering a metric name twice on one registry, so a
// second `startDiffWorker` on the same registry (a harness that runs more than
// once in a process) reuses the first call's metrics.
const metricsByRegistry = new WeakMap<Registry, RuntimeMetrics>();

function runtimeMetrics(registry: Registry): RuntimeMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;
  const created: RuntimeMetrics = {
    diff: createDiffMetrics(registry),
    deadLettered: new Counter({
      name: "furan_diff_jobs_dead_lettered_total",
      help: "Diff jobs that exhausted all retries (permanently failed)",
      registers: [registry],
    }),
  };
  metricsByRegistry.set(registry, created);
  return created;
}

/**
 * BullMQ leaves open the ioredis connection it was handed, so `close()` has to
 * release it. This captures it once it is ready and returns the function that
 * releases it, but `close()` never waits on it: a queue or worker's `client`
 * settles only once the connection is ready (or ended), so a connection to an
 * unreachable Redis would otherwise make `close()` hang, where BullMQ's own
 * `close()` handles that state.
 */
function trackClient(owner: {
  client: Promise<{ disconnect(): void }>;
}): () => void {
  let client: { disconnect(): void } | undefined;
  let released = false;
  void owner.client.then(
    (c) => {
      client = c;
      // The connection came up after `release()` already ran: drop it now.
      if (released) c.disconnect();
    },
    () => undefined,
  );
  return () => {
    released = true;
    client?.disconnect();
  };
}

/**
 * Start the diff worker: the BullMQ consumer of the `diff` queue, its
 * job metrics, its dead-letter signal, the queue-depth gauge and (unless
 * turned off) the stale-run sweeper. `server.ts` runs it as the service; the
 * scale harness runs it in-process.
 */
export function startDiffWorker(
  opts: DiffWorkerRuntimeOptions,
): DiffWorkerRuntime {
  const { db, storage, redis, logger, registry } = opts;
  const handler = opts.handler ?? handleDiffJob;
  const metrics = runtimeMetrics(registry);
  const jobMetrics = createDiffJobMetrics(registry);

  const prefix = opts.queuePrefix ? { prefix: opts.queuePrefix } : {};

  // The queue the worker consumes: same name, same prefix. The handler adds
  // the per-step jobs of an old whole-run job to it, and the depth gauge reads
  // it. It gets its own connection, so a slow or hung read never queues
  // behind the worker's blocking commands.
  const queue = createQueue("diff", prefix);
  // A connection error on this queue surfaces elsewhere: through the gauge, as
  // a rate-limited `diff_queue_depth_unavailable`, and through a job that
  // needed the queue, which fails. Without a listener BullMQ would print
  // every one to stderr.
  queue.on("error", () => undefined);

  const worker = createWorker(
    "diff",
    async (job) => {
      logger.info(
        {
          jobId: job.id,
          projectId: job.data.projectId,
          screenshotId: job.data.screenshotId,
          generation: job.data.generation,
        },
        "diff_job_received",
      );
      // Only the final attempt may mark the run `aborted` (ruling R9); an
      // earlier failure is retried by BullMQ and the retry derives the status.
      const finalAttempt = isFinalAttempt(job);
      const started = performance.now();
      const seconds = (): number => (performance.now() - started) / 1000;
      // A metric only observes: if recording one throws, the job's outcome
      // (and the handler's own error) stands.
      const observe = (
        outcome: DiffJobAttemptOutcome,
        checkpoints: number | null,
      ): void => {
        try {
          jobMetrics.observeAttempt(job, outcome, seconds(), checkpoints);
        } catch (err) {
          logger.warn({ err, jobId: job.id }, "diff_job_metric_failed");
        }
      };
      let result: Awaited<ReturnType<typeof handler>>;
      try {
        result = await handler(
          job.data,
          logger,
          { db, storage, redis, metrics: metrics.diff, queue },
          { finalAttempt },
        );
      } catch (err) {
        observe(finalAttempt ? "failed" : "retry", null);
        throw err;
      }
      // Outside the try: only the handler's failure is the job's failure.
      observe(result.stale ? "stale" : "completed", result.checkpoints);
    },
    {
      ...(opts.concurrency !== undefined
        ? { concurrency: opts.concurrency }
        : {}),
      ...prefix,
    },
  );

  // Dead-letter signal: a diff that exhausts its retries leaves a run stuck
  // without a verdict. Surface terminal failures as a metric + error log for
  // alerting; transient (will-retry) failures stay at warn.
  worker.on("failed", (job, err) => {
    if (isTerminalFailure(job)) {
      metrics.deadLettered.inc();
      logger.error(
        {
          err,
          jobId: job?.id,
          projectId: job?.data?.projectId,
          attemptsMade: job?.attemptsMade,
        },
        "diff_job_dead_lettered",
      );
    } else {
      logger.warn(
        { err, jobId: job?.id, attemptsMade: job?.attemptsMade },
        "diff_job_failed_will_retry",
      );
    }
  });

  // Every 30 s, finalize any "running" run whose updatedAt is older than
  // 5 minutes. Covers SDK 1.0.x callers that never send POST /runs/:id/complete.
  const sweeperInterval =
    opts.sweeper === false
      ? undefined
      : setInterval(() => {
          sweepStaleRuns({ db, logger }).catch((e) =>
            logger.warn({ err: e }, "sweeper_failed"),
          );
        }, SWEEP_INTERVAL_MS);

  registerQueueDepthGauge(
    registry,
    () => queue.getJobCounts("waiting", "active", "delayed", "failed"),
    logger,
  );

  const releaseWorkerClient = trackClient(worker);
  const releaseQueueClient = trackClient(queue);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (sweeperInterval) clearInterval(sweeperInterval);
      try {
        // The worker first, so the gauge still answers while it drains.
        await worker.close();
      } finally {
        try {
          await queue.close();
        } finally {
          releaseWorkerClient();
          releaseQueueClient();
        }
      }
    })();
    return closing;
  };

  return { worker, close };
}
