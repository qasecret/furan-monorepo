import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import type { DB } from "@furan/db";
import { createQueue, type DiffJob, type Queue } from "@furan/queue";
import type { Storage } from "@furan/storage";
import type { Redis } from "ioredis";
import { Registry } from "prom-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { handleDiffJob } from "../src/handler.js";
import { createDiffJobMetrics } from "../src/job-metrics.js";
import { startDiffWorker, type DiffWorkerRuntime } from "../src/runtime.js";

const PROJECT = "00000000-0000-0000-0000-000000000002";
const RETRY_ONCE = "00000000-0000-0000-0000-0000000000aa";
const OK = "00000000-0000-0000-0000-0000000000bb";

type Sample = {
  metricName?: string;
  labels: Record<string, string | number | undefined>;
  value: number;
};

async function histogramSeries(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<{ count: number; sum: number }> {
  const metric = (await registry.getMetricsAsJSON()).find(
    (m) => m.name === name,
  );
  if (!metric) return { count: 0, sum: 0 };
  const samples = metric.values as Sample[];
  const pick = (suffix: string): number =>
    samples.find(
      (s) =>
        s.metricName === `${name}${suffix}` &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v),
    )?.value ?? 0;
  return { count: pick("_count"), sum: pick("_sum") };
}

/** Resolve when `job` leaves the worker, completed or failed. */
function settled(
  runtime: DiffWorkerRuntime,
  event: "completed" | "failed",
  runId: string,
): Promise<void> {
  return new Promise((resolve) => {
    const listener = (job: { data: DiffJob } | undefined): void => {
      if (job?.data.runId !== runId) return;
      runtime.worker.off(event, listener);
      resolve();
    };
    runtime.worker.on(event, listener);
  });
}

const noop = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe.skipIf(!process.env.REDIS_URL)("startDiffWorker", () => {
  let prefix: string;
  let queue: Queue<DiffJob>;
  let registry: Registry;
  let runtime: DiffWorkerRuntime | undefined;
  const calls = new Map<string, number>();

  // Succeeds with 7 checkpoints; the RETRY_ONCE run throws on its first call.
  const stub: typeof handleDiffJob = async (data) => {
    const n = (calls.get(data.runId) ?? 0) + 1;
    calls.set(data.runId, n);
    if (data.runId === RETRY_ONCE && n === 1) throw new Error("boom");
    return { checkpoints: 7 };
  };

  const start = (): DiffWorkerRuntime =>
    startDiffWorker({
      db: {} as DB,
      storage: {} as Storage,
      redis: {} as Redis,
      logger: noop as never,
      registry,
      queuePrefix: prefix,
      concurrency: 1,
      sweeper: false,
      handler: stub,
    });

  beforeEach(() => {
    prefix = `furan-scale-test-${randomUUID().slice(0, 8)}`;
    queue = createQueue("diff", { prefix });
    registry = new Registry();
    calls.clear();
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    const client = await queue.client;
    await queue.obliterate({ force: true });
    await queue.close();
    // BullMQ leaves a connection it was handed open; the queue was given one.
    client.disconnect();
  });

  it("records duration, queue wait and checkpoints for a completed job", async () => {
    runtime = start();
    const done = settled(runtime, "completed", OK);
    await queue.add("diff", { runId: OK, projectId: PROJECT });
    await done;

    expect(
      (
        await histogramSeries(registry, "furan_diff_job_duration_seconds", {
          outcome: "completed",
        })
      ).count,
    ).toBe(1);
    const checkpoints = await histogramSeries(
      registry,
      "furan_diff_job_checkpoints",
    );
    expect(checkpoints).toEqual({ count: 1, sum: 7 });
    const wait = await histogramSeries(
      registry,
      "furan_diff_job_queue_wait_seconds",
    );
    expect(wait.count).toBe(1);
    expect(wait.sum).toBeGreaterThanOrEqual(0);
  });

  it("counts a retried attempt once as retry and waits only on the first attempt", async () => {
    runtime = start();
    const done = settled(runtime, "completed", RETRY_ONCE);
    await queue.add(
      "diff",
      { runId: RETRY_ONCE, projectId: PROJECT },
      { attempts: 2, backoff: { type: "fixed", delay: 0 } },
    );
    await done;

    expect(calls.get(RETRY_ONCE)).toBe(2);
    expect(
      (
        await histogramSeries(registry, "furan_diff_job_duration_seconds", {
          outcome: "retry",
        })
      ).count,
    ).toBe(1);
    expect(
      (
        await histogramSeries(registry, "furan_diff_job_duration_seconds", {
          outcome: "completed",
        })
      ).count,
    ).toBe(1);
    // The failed attempt reports no checkpoints; the second one reports 7.
    expect(
      await histogramSeries(registry, "furan_diff_job_checkpoints"),
    ).toEqual({ count: 1, sum: 7 });
    // One wait sample: the retry waited on its backoff, not on the queue.
    expect(
      (await histogramSeries(registry, "furan_diff_job_queue_wait_seconds"))
        .count,
    ).toBe(1);
  });

  it("records a job that exhausts its attempts as failed and dead-lettered", async () => {
    const always: typeof handleDiffJob = async () => {
      throw new Error("always");
    };
    runtime = startDiffWorker({
      db: {} as DB,
      storage: {} as Storage,
      redis: {} as Redis,
      logger: noop as never,
      registry,
      queuePrefix: prefix,
      sweeper: false,
      handler: always,
    });
    const done = settled(runtime, "failed", OK);
    await queue.add("diff", { runId: OK, projectId: PROJECT }, { attempts: 1 });
    await done;

    expect(
      (
        await histogramSeries(registry, "furan_diff_job_duration_seconds", {
          outcome: "failed",
        })
      ).count,
    ).toBe(1);
    const dead = (await registry.getMetricsAsJSON()).find(
      (m) => m.name === "furan_diff_jobs_dead_lettered_total",
    );
    expect((dead?.values as Sample[])[0]?.value).toBe(1);
  });

  it("completes a job whose completed-attempt metric throws, without a retry", async () => {
    // The instance the runtime will use: one per registry.
    const jobMetrics = createDiffJobMetrics(registry);
    const observed: string[] = [];
    vi.spyOn(jobMetrics, "observeAttempt").mockImplementation(
      (_job, outcome) => {
        observed.push(outcome);
        if (outcome === "completed") throw new Error("metric boom");
      },
    );
    const warn = vi.fn();
    runtime = startDiffWorker({
      db: {} as DB,
      storage: {} as Storage,
      redis: {} as Redis,
      logger: { ...noop, warn } as never,
      registry,
      queuePrefix: prefix,
      concurrency: 1,
      sweeper: false,
      handler: stub,
    });
    const done = settled(runtime, "completed", OK);
    // Two attempts: a throw out of the processor would be retried.
    const job = await queue.add(
      "diff",
      { runId: OK, projectId: PROJECT },
      { attempts: 2, backoff: { type: "fixed", delay: 0 } },
    );
    await done;

    expect(calls.get(OK)).toBe(1);
    expect(observed).toEqual(["completed"]);
    expect(await job.getState()).toBe("completed");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }),
      "diff_job_metric_failed",
    );
  });

  it("reports the depth of its own queue, and only that queue", async () => {
    // Hold every job open so the first sits `active` and the rest `waiting`.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: typeof handleDiffJob = async () => {
      await gate;
      return { checkpoints: 1 };
    };
    // A job on a queue with a different prefix must not be counted.
    const otherPrefix = `${prefix}-other`;
    const other = createQueue("diff", { prefix: otherPrefix });
    const otherClient = await other.client;
    try {
      runtime = startDiffWorker({
        db: {} as DB,
        storage: {} as Storage,
        redis: {} as Redis,
        logger: noop as never,
        registry,
        queuePrefix: prefix,
        concurrency: 1,
        sweeper: false,
        handler: held,
      });
      await other.add("diff", { runId: OK, projectId: PROJECT });
      for (const n of [1, 2, 3]) {
        await queue.add("diff", {
          runId: `00000000-0000-0000-0000-00000000010${n}`,
          projectId: PROJECT,
        });
      }

      await vi.waitFor(async () => {
        const text = await registry.metrics();
        expect(text).toContain('furan_diff_queue_jobs{state="active"} 1');
        expect(text).toContain('furan_diff_queue_jobs{state="waiting"} 2');
      });
      const text = await registry.metrics();
      expect(text).toContain('furan_diff_queue_jobs{state="delayed"} 0');
      expect(text).toContain('furan_diff_queue_jobs{state="failed"} 0');
    } finally {
      release();
      await other.obliterate({ force: true });
      await other.close();
      otherClient.disconnect();
    }
  });

  it("can start twice on one registry and closes cleanly", async () => {
    const first = start();
    await first.close();
    runtime = start();
    expect(runtime.worker.isRunning()).toBe(true);
    await runtime.close();
    // A second close is a no-op that resolves.
    await runtime.close();
    // BullMQ flips `isRunning` once its main loop has unwound, a tick after
    // `close()` resolves.
    await vi.waitFor(() => expect(runtime?.worker.isRunning()).toBe(false));
  });

  it("closes promptly when the worker's connection never became ready", async () => {
    // A server on an ephemeral localhost port that accepts a connection and
    // never answers: the worker's connection reaches the socket but never
    // becomes ready, so BullMQ's `worker.client` never settles. (A closed port
    // would do too, but its reconnect attempts spam stderr for the rest of the
    // run.) Stopping the listener leaves the accepted sockets as they are, for
    // the same reason; they go with the test process.
    let connected!: () => void;
    const accepted = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const blackHole = createServer((socket) => {
      socket.on("error", () => undefined);
      connected();
    });
    blackHole.unref();
    const port = await new Promise<number>((resolve, reject) => {
      blackHole.once("error", reject);
      blackHole.listen(0, "127.0.0.1", () =>
        resolve((blackHole.address() as { port: number }).port),
      );
    });
    // `createWorker` reads REDIS_URL when it builds the worker's connection,
    // synchronously inside `startDiffWorker`; only that call sees the override.
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    let unready: DiffWorkerRuntime;
    try {
      unready = start();
    } finally {
      if (original === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = original;
    }
    unready.worker.on("error", () => undefined);

    try {
      // Close only once the worker's connection has reached the socket, so it
      // is stuck waiting on a reply rather than still dialling.
      await accepted;
      // The depth gauge reads through the same dead connection: `/metrics`
      // must still answer, within the gauge's cap.
      const scrapeStarted = performance.now();
      await registry.metrics();
      expect(performance.now() - scrapeStarted).toBeLessThan(2_000);
      const started = performance.now();
      const closed = await Promise.race([
        unready.close().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 2_000),
        ),
      ]);
      expect(closed).toBe(true);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      blackHole.close();
    }
  });
});
