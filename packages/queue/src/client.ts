import {
  Queue,
  Worker,
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

export { Queue, Worker } from "bullmq";
