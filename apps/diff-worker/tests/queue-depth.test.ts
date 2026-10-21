import { Registry } from "prom-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerQueueDepthGauge } from "../src/queue-depth.js";

const COUNTS = { waiting: 3, active: 1, delayed: 0, failed: 2 };

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

type CountsFn = () => Promise<Record<string, number>>;

/** A `counts` whose behaviour a test can swap between scrapes. */
function switchable(initial: CountsFn): {
  counts: CountsFn;
  set(next: CountsFn): void;
} {
  let current = initial;
  return { counts: () => current(), set: (next) => (current = next) };
}

const never: CountsFn = () => new Promise(() => undefined);
const failing: CountsFn = () => Promise.reject(new Error("redis down"));

describe("registerQueueDepthGauge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets the four states", async () => {
    const registry = new Registry();
    registerQueueDepthGauge(
      registry,
      () => Promise.resolve(COUNTS),
      fakeLogger() as never,
    );

    const text = await registry.metrics();
    expect(text).toContain('furan_diff_queue_jobs{state="waiting"} 3');
    expect(text).toContain('furan_diff_queue_jobs{state="active"} 1');
    expect(text).toContain('furan_diff_queue_jobs{state="delayed"} 0');
    expect(text).toContain('furan_diff_queue_jobs{state="failed"} 2');
  });

  it("reads the counts afresh on every scrape", async () => {
    const registry = new Registry();
    const source = switchable(() => Promise.resolve(COUNTS));
    registerQueueDepthGauge(registry, source.counts, fakeLogger() as never);
    await registry.metrics();

    source.set(() =>
      Promise.resolve({ waiting: 40, active: 4, delayed: 5, failed: 6 }),
    );
    const text = await registry.metrics();
    expect(text).toContain('furan_diff_queue_jobs{state="waiting"} 40');
    expect(text).toContain('furan_diff_queue_jobs{state="failed"} 6');
  });

  it("returns within the cap when counts hangs, keeping the last values", async () => {
    const registry = new Registry();
    const source = switchable(() => Promise.resolve(COUNTS));
    registerQueueDepthGauge(registry, source.counts, fakeLogger() as never, 50);
    await registry.metrics();

    source.set(never);
    const started = performance.now();
    const text = await registry.metrics();
    expect(performance.now() - started).toBeLessThan(500);
    expect(text).toContain('furan_diff_queue_jobs{state="waiting"} 3');
    expect(text).toContain('furan_diff_queue_jobs{state="failed"} 2');
  });

  it("keeps the last values when counts fails", async () => {
    const registry = new Registry();
    const source = switchable(() => Promise.resolve(COUNTS));
    registerQueueDepthGauge(registry, source.counts, fakeLogger() as never);
    await registry.metrics();

    source.set(failing);
    const text = await registry.metrics();
    expect(text).toContain('furan_diff_queue_jobs{state="active"} 1');
  });

  it("reports no sample before the first successful read", async () => {
    // A 0 here would read as "the queue is empty" while Redis is unreachable.
    const registry = new Registry();
    registerQueueDepthGauge(registry, failing, fakeLogger() as never);

    const text = await registry.metrics();
    expect(text).toContain("# TYPE furan_diff_queue_jobs gauge");
    expect(text).not.toContain("furan_diff_queue_jobs{");
  });

  it("logs unavailability at most once a minute", async () => {
    vi.useFakeTimers();
    const registry = new Registry();
    const logger = fakeLogger();
    registerQueueDepthGauge(registry, failing, logger as never);

    await registry.metrics();
    await registry.metrics();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "diff_queue_depth_unavailable",
    );

    // Still inside the minute.
    await vi.advanceTimersByTimeAsync(59_000);
    await registry.metrics();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // A minute after the first log, the next failure logs again.
    await vi.advanceTimersByTimeAsync(1_000);
    await registry.metrics();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("logs a timeout the same way as a failure", async () => {
    vi.useFakeTimers();
    const registry = new Registry();
    const logger = fakeLogger();
    registerQueueDepthGauge(registry, never, logger as never, 50);

    const scraped = registry.metrics();
    await vi.advanceTimersByTimeAsync(50);
    await scraped;
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "diff_queue_depth_unavailable",
    );
  });

  it("does not leave a timer behind after a scrape that beat the cap", async () => {
    vi.useFakeTimers();
    const registry = new Registry();
    registerQueueDepthGauge(
      registry,
      () => Promise.resolve(COUNTS),
      fakeLogger() as never,
    );

    await registry.metrics();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("registers once per registry: a second call swaps the source", async () => {
    // A harness that starts the worker twice on one registry would otherwise
    // throw on the duplicate metric name, or keep reading a closed queue.
    const registry = new Registry();
    registerQueueDepthGauge(registry, failing, fakeLogger() as never);
    registerQueueDepthGauge(
      registry,
      () => Promise.resolve({ waiting: 9, active: 0, delayed: 0, failed: 0 }),
      fakeLogger() as never,
    );

    const text = await registry.metrics();
    expect(text.match(/# TYPE furan_diff_queue_jobs gauge/g)).toHaveLength(1);
    expect(text).toContain('furan_diff_queue_jobs{state="waiting"} 9');
  });
});
