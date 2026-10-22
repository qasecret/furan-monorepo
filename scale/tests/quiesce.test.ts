import { describe, expect, it } from "vitest";

import {
  QUIESCE_ACTIVE_MS,
  QUIESCE_DRAIN_MS,
  describeQuiesce,
  quiesce,
  type QuiesceQueue,
} from "../src/quiesce.js";

type Counts = { waiting: number; active: number; delayed: number };

/**
 * A diff queue whose `waitIdle` answers are scripted, one per call, and
 * whose counts move on as it is asked; the clock moves by what each wait
 * took.
 */
function fakeQueue(script: {
  idle: boolean[];
  counts: Counts[];
  /** How long each `waitIdle` takes, in ms. */
  waits?: number[];
}) {
  let clock = 0;
  const log: string[] = [];
  const idle = [...script.idle];
  const counts = [...script.counts];
  const waits = [...(script.waits ?? [])];
  const queue: QuiesceQueue = {
    async waitIdle(timeoutMs) {
      log.push(`waitIdle ${timeoutMs}`);
      const answer = idle.shift();
      if (answer === undefined) throw new Error("unscripted waitIdle");
      clock += waits.shift() ?? (answer ? 0 : timeoutMs);
      return answer;
    },
    async counts() {
      log.push("counts");
      const c = counts.shift();
      if (c === undefined) throw new Error("unscripted counts");
      return c;
    },
    async dropWaiting() {
      log.push("dropWaiting");
    },
  };
  return { queue, log, now: () => clock };
}

describe("quiesce (Ruling R48)", () => {
  it("waits up to 10 min, then 2 min for the running jobs", () => {
    expect(QUIESCE_DRAIN_MS).toBe(10 * 60_000);
    expect(QUIESCE_ACTIVE_MS).toBe(2 * 60_000);
  });

  it("drops nothing when the queue empties on its own", async () => {
    const f = fakeQueue({ idle: [true], counts: [], waits: [42_300] });
    const outcome = await quiesce(f.queue, { now: f.now });
    expect(outcome).toEqual({ kind: "drained", ms: 42_300 });
    expect(f.log).toEqual([`waitIdle ${QUIESCE_DRAIN_MS}`]);
    expect(describeQuiesce("browser", outcome)).toBe(
      "quiesce after browser: drained in 42.3s",
    );
  });

  it("past the drain time, drops what is queued and waits for the running jobs", async () => {
    const f = fakeQueue({
      idle: [false, true],
      counts: [{ waiting: 120, active: 4, delayed: 3 }],
      waits: [QUIESCE_DRAIN_MS, 35_000],
    });
    const outcome = await quiesce(f.queue, { now: f.now });
    expect(outcome).toEqual({
      kind: "dropped",
      dropped: 123,
      left: 0,
      ms: QUIESCE_DRAIN_MS + 35_000,
    });
    // Counted before the drop, dropped once, then the shorter wait.
    expect(f.log).toEqual([
      `waitIdle ${QUIESCE_DRAIN_MS}`,
      "counts",
      "dropWaiting",
      `waitIdle ${QUIESCE_ACTIVE_MS}`,
    ]);
    expect(describeQuiesce("browser", outcome)).toBe(
      "quiesce after browser: 123 jobs dropped (still queued after 10 min); the running ones finished (635.0s in all)",
    );
  });

  it("says what is left when the running jobs outlast their wait too", async () => {
    const f = fakeQueue({
      idle: [false, false],
      counts: [
        { waiting: 1, active: 4, delayed: 0 },
        { waiting: 0, active: 2, delayed: 0 },
      ],
    });
    const outcome = await quiesce(f.queue, { now: f.now });
    expect(outcome).toMatchObject({ kind: "dropped", dropped: 1, left: 2 });
    expect(describeQuiesce("server", outcome)).toBe(
      "quiesce after server: 1 job dropped (still queued after 10 min); 2 jobs still in the queue 2 min later",
    );
  });

  it("takes shorter waits when given them", async () => {
    const f = fakeQueue({
      idle: [false, true],
      counts: [{ waiting: 2, active: 0, delayed: 0 }],
    });
    await quiesce(f.queue, { drainMs: 1_000, activeMs: 500, now: f.now });
    expect(f.log).toEqual([
      "waitIdle 1000",
      "counts",
      "dropWaiting",
      "waitIdle 500",
    ]);
  });

  it("lets a failure through to the caller", async () => {
    const queue: QuiesceQueue = {
      waitIdle: async () => {
        throw new Error("redis went away");
      },
      counts: async () => ({ waiting: 0, active: 0, delayed: 0 }),
      dropWaiting: async () => undefined,
    };
    await expect(quiesce(queue)).rejects.toThrow("redis went away");
  });
});
