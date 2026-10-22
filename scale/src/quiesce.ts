import type { Suite } from "./budgets.js";

/**
 * Ruling R48: a suite starts on a quiet system. After each suite the CLI waits
 * for the harness's diff queue to empty; past `QUIESCE_DRAIN_MS` it drops what
 * is still queued (the harness's own queue only: its jobs are harness data)
 * and waits up to `QUIESCE_ACTIVE_MS` for the running ones. A backlog left by
 * one suite (D4's 500-step upload diffs quadratically) would otherwise run
 * through the next suite's measurements.
 */

/** How long the diff queue may take to empty on its own after a suite. */
export const QUIESCE_DRAIN_MS = 10 * 60_000;
/** Once the rest is dropped, how long the running jobs may take to finish. */
export const QUIESCE_ACTIVE_MS = 2 * 60_000;

/** What the quiesce reads and does: the harness's diff queue (`openQueueProbe`). */
export interface QuiesceQueue {
  counts(): Promise<{ waiting: number; active: number; delayed: number }>;
  /** True once the queue is idle (nothing waiting, active or delayed). */
  waitIdle(timeoutMs: number): Promise<boolean>;
  /** Removes every waiting and delayed job; active ones run to the end. */
  dropWaiting(): Promise<void>;
}

export type QuiesceOutcome =
  /** The queue emptied on its own. */
  | { kind: "drained"; ms: number }
  /**
   * `dropped` jobs (waiting or delayed when the drain time ran out) were
   * removed; `left` jobs were still in the queue when the wait for the
   * running ones ran out too (0: it emptied).
   */
  | { kind: "dropped"; dropped: number; left: number; ms: number };

export interface QuiesceOptions {
  drainMs?: number;
  activeMs?: number;
  /** The clock, in ms (default `performance.now`). */
  now?: () => number;
}

/** Waits for the diff queue to empty, dropping its backlog past the drain time. */
export async function quiesce(
  queue: QuiesceQueue,
  opts: QuiesceOptions = {},
): Promise<QuiesceOutcome> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  if (await queue.waitIdle(opts.drainMs ?? QUIESCE_DRAIN_MS)) {
    return { kind: "drained", ms: now() - started };
  }
  const { waiting, delayed } = await queue.counts();
  await queue.dropWaiting();
  let left = 0;
  if (!(await queue.waitIdle(opts.activeMs ?? QUIESCE_ACTIVE_MS))) {
    const c = await queue.counts();
    left = c.waiting + c.active + c.delayed;
  }
  return {
    kind: "dropped",
    dropped: waiting + delayed,
    left,
    ms: now() - started,
  };
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * The report header's line for one quiesce: "quiesce after <suite>: drained in
 * Xs" or "quiesce after <suite>: N jobs dropped", with what else it found.
 */
export function describeQuiesce(
  suite: Suite,
  outcome: QuiesceOutcome,
  opts: Pick<QuiesceOptions, "drainMs" | "activeMs"> = {},
): string {
  const head = `quiesce after ${suite}:`;
  if (outcome.kind === "drained")
    return `${head} drained in ${secs(outcome.ms)}`;
  const drainMin = (opts.drainMs ?? QUIESCE_DRAIN_MS) / 60_000;
  const activeMin = (opts.activeMs ?? QUIESCE_ACTIVE_MS) / 60_000;
  const jobs = (n: number): string => `${n} job${n === 1 ? "" : "s"}`;
  const rest =
    outcome.left === 0
      ? `the running ones finished (${secs(outcome.ms)} in all)`
      : `${jobs(outcome.left)} still in the queue ${activeMin} min later`;
  return `${head} ${jobs(outcome.dropped)} dropped (still queued after ${drainMin} min); ${rest}`;
}
