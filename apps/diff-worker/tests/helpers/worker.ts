import { randomUUID } from "node:crypto";

import type { DB } from "@furan/db";
import { createQueue, diffJobId, type DiffJob, type Queue } from "@furan/queue";
import type { Storage } from "@furan/storage";
import type { Redis } from "ioredis";
import { Registry } from "prom-client";

import {
  handleDiffJob,
  type DiffJobOutcome,
  type StepJob,
} from "../../src/handler.js";
import { startDiffWorker } from "../../src/runtime.js";

/**
 * The worker, in this process, on its own queue: every job it handles runs the
 * real `handleDiffJob`, and its outcome is recorded. `run(job)` queues a step
 * job (one attempt, so a failure is its final one) and resolves when the job
 * completes, or rejects with its error when it fails. The worker, its queue and
 * its keys are gone when `fn` returns.
 */
export async function withDiffWorker(
  deps: {
    db: DB;
    storage: Storage;
    redis: Redis;
    logger: Parameters<typeof handleDiffJob>[1];
  },
  fn: (w: {
    queue: Queue<DiffJob>;
    registry: Registry;
    outcomes: DiffJobOutcome[];
    run: (job: StepJob) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const prefix = `furan-test-${randomUUID().slice(0, 8)}`;
  const queue = createQueue("diff", { prefix });
  const registry = new Registry();
  const outcomes: DiffJobOutcome[] = [];
  const runtime = startDiffWorker({
    ...deps,
    registry,
    queuePrefix: prefix,
    concurrency: 1,
    sweeper: false,
    handler: async (...args) => {
      const outcome = await handleDiffJob(...args);
      outcomes.push(outcome);
      return outcome;
    },
  });
  const run = async (job: StepJob): Promise<void> => {
    const jobId = diffJobId(job.screenshotId, job.generation);
    const done = new Promise<void>((resolve, reject) => {
      runtime.worker.on("completed", (j) => {
        if (j.id === jobId) resolve();
      });
      runtime.worker.on("failed", (j, err) => {
        if (j?.id === jobId) reject(err);
      });
    });
    await queue.add("diff", job, { jobId, attempts: 1 });
    await done;
  };
  try {
    await fn({ queue, registry, outcomes, run });
  } finally {
    await runtime.close();
    const client = await queue.client;
    await queue.obliterate({ force: true });
    await queue.close();
    client.disconnect();
  }
}
