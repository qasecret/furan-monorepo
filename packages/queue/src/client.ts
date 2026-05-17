import { Queue, Worker, type Processor, type WorkerOptions } from "bullmq";

import { createRedisConnection } from "./connection.js";
import type { JobMap, JobName } from "./jobs.js";

export function createQueue<N extends JobName>(name: N): Queue<JobMap[N]> {
  return new Queue<JobMap[N]>(name, { connection: createRedisConnection() });
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
