import {
  Queue,
  Worker,
  type Job,
  type JobsOptions,
  type Processor,
  type WorkerOptions,
} from "bullmq";

import { createRedisConnection } from "./connection.js";
import type { JobMap, JobName } from "./jobs.js";

/**
 * Retry defaults applied to every enqueued job. BullMQ's own default is a
 * single attempt, so a transient failure (a brief Redis blip, a Playwright
 * `page.goto` timeout, a momentary S3/VLM hiccup) permanently drops the job
 * and silently loses a test result. Three attempts with exponential backoff
 * recovers from transients without hammering a genuinely-down dependency.
 *
 * `removeOnComplete`/`removeOnFail` bound Redis growth: completed jobs are
 * pruned aggressively; failed jobs are retained longer for post-mortem before
 * capping by count.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600, count: 5_000 },
};

export function createQueue<N extends JobName>(name: N): Queue<JobMap[N]> {
  return new Queue<JobMap[N]>(name, {
    connection: createRedisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

export function createWorker<N extends JobName>(
  name: N,
  processor: Processor<JobMap[N]>,
  opts: Partial<WorkerOptions> = {},
): Worker<JobMap[N]> {
  return new Worker<JobMap[N]>(name, processor, {
    connection: createRedisConnection(),
    concurrency: 4,
    ...opts,
  });
}

/**
 * Convenience constructor for the retention TTL queue (Phase 5 D3). Thin
 * wrapper around `createQueue("retention")` — kept distinct so callers
 * (CLI, server bootstrap) don't have to remember the magic string and so
 * the queue name lives in one place if it ever needs to change.
 */
export function createRetentionQueue(): Queue<JobMap["retention"]> {
  return createQueue("retention");
}

/**
 * True when a `failed` event is the job's LAST attempt — i.e. it has now
 * exhausted its retry budget and BullMQ will not re-run it (a "dead letter").
 * The `failed` event fires on every attempt; workers use this to distinguish a
 * transient failure that will retry from a terminal one worth alerting on.
 *
 * `attemptsMade` is the count INCLUDING the attempt that just failed, so the
 * job is terminal once it reaches the configured `attempts` (falling back to
 * the queue default, then 1 if a job somehow carries no options).
 */
export function isTerminalFailure(job: Job | undefined): boolean {
  if (!job) return true; // no job handle → can't retry → treat as terminal
  const attempts =
    job.opts?.attempts ?? (DEFAULT_JOB_OPTIONS.attempts as number) ?? 1;
  return (job.attemptsMade ?? 0) >= attempts;
}

export { Queue, Worker } from "bullmq";
export type { Job } from "bullmq";
