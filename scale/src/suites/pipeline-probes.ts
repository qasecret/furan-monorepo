import { setTimeout as sleep } from "node:timers/promises";

import { and, eq, isNotNull, screenshots, testRuns, type DB } from "@furan/db";
import { createQueue, type Redis } from "@furan/queue";

import { QUEUE_PREFIX } from "../stack/constants.js";
import { releaseRedis } from "../stack/worker.js";

/**
 * What the pipeline suite watches while it drives the stack: one run's rows
 * (`RunWatcher`), the diff queue (`openQueueProbe`), the project's live events
 * (`subscribeProjectEvents`) and the run's own status events
 * (`subscribeRunStatuses`). Every wait is bounded.
 */

/** How often the database and the queue are polled (spec §5.2). */
export const POLL_MS = 100;
/** A step with no result this long after its upload is a failed sample. */
export const STEP_TIMEOUT_MS = 120_000;

/** Runs `fn` once; later calls get the first call's promise. */
export function once(fn: () => Promise<void>): () => Promise<void> {
  let ran: Promise<void> | undefined;
  return () => (ran ??= fn());
}

/** One uploaded step: when its upload answered and when its verdict was first seen. */
export interface StepTiming {
  screenshotId: string;
  uploadedAt: number;
  resultAt?: number;
}

/**
 * Polls one run every `POLL_MS` from its creation: the first time each
 * uploaded step has a verdict, and every change of `test_runs.status`. Times
 * are `performance.now()` at the end of the poll that saw them, which is when
 * the harness learned them.
 */
export class RunWatcher {
  private readonly steps = new Map<string, StepTiming>();
  private readonly waiters = new Set<() => void>();
  private status: string;
  private final: { after: number; seen?: { status: string; at: number } } = {
    after: Infinity,
  };
  private failure: unknown;
  private stopped = false;
  private readonly loop: Promise<void>;
  /** Every status change seen, in order. */
  readonly changes: { status: string; at: number }[] = [];

  /**
   * @param initialStatus the status the run was created with (`running`).
   * @param alive throws once the harness is tearing down.
   */
  constructor(
    private readonly db: DB,
    readonly runId: string,
    initialStatus: string,
    private readonly alive: () => void = () => undefined,
  ) {
    this.status = initialStatus;
    this.loop = this.run();
  }

  /** Records a step's upload response; its result is polled from now on. */
  uploaded(screenshotId: string, at: number): void {
    if (!this.steps.has(screenshotId)) {
      this.steps.set(screenshotId, { screenshotId, uploadedAt: at });
    }
  }

  /** The steps uploaded so far, in upload order. */
  timings(): StepTiming[] {
    return [...this.steps.values()].map((s) => ({ ...s }));
  }

  /**
   * From now on, watch for the first status other than `running` seen by a
   * poll that started after `after` (a poll that started earlier can return a
   * status from before the last upload committed).
   */
  armFinal(after: number): void {
    this.final = { after };
  }

  /**
   * The status `armFinal` watches for and when it was seen, or null if it is
   * not seen within `timeoutMs`.
   */
  async finalStatus(
    timeoutMs: number,
  ): Promise<{ status: string; at: number } | null> {
    await this.waitFor(() => this.final.seen !== undefined, timeoutMs);
    return this.final.seen ?? null;
  }

  /**
   * Resolves once every uploaded step has a result or is past
   * `STEP_TIMEOUT_MS` since its upload.
   */
  async settled(): Promise<void> {
    await this.waitFor(
      () => {
        const now = performance.now();
        for (const step of this.steps.values()) {
          if (
            step.resultAt === undefined &&
            now - step.uploadedAt < STEP_TIMEOUT_MS
          ) {
            return false;
          }
        }
        return true;
      },
      STEP_TIMEOUT_MS + 10 * POLL_MS,
    );
  }

  /** Stops polling (idempotent); a wait still pending resolves as timed out. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    this.notify();
  }

  /**
   * True once `predicate` holds after a poll; false when `timeoutMs` passes or
   * the watcher stops first. Rejects if a poll failed.
   */
  private waitFor(
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    return new Promise<boolean>((resolve, reject) => {
      const check = (): void => {
        let outcome: boolean | undefined;
        if (this.failure !== undefined) {
          this.waiters.delete(check);
          reject(this.failure);
          return;
        }
        if (predicate()) outcome = true;
        else if (this.stopped || performance.now() >= deadline) outcome = false;
        if (outcome !== undefined) {
          this.waiters.delete(check);
          resolve(outcome);
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const startedAt = performance.now();
      try {
        this.alive();
        await this.poll(startedAt);
      } catch (error) {
        this.failure = error;
        this.stopped = true;
      }
      this.notify();
      const wait = POLL_MS - (performance.now() - startedAt);
      if (!this.stopped && wait > 0) await sleep(wait);
    }
  }

  private async poll(startedAt: number): Promise<void> {
    const [diffed, runs] = await Promise.all([
      this.db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(
          and(
            eq(screenshots.runId, this.runId),
            isNotNull(screenshots.verdict),
          ),
        ),
      this.db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, this.runId)),
    ]);
    const at = performance.now();
    for (const { id } of diffed) {
      const step = this.steps.get(id);
      if (step !== undefined && step.resultAt === undefined) step.resultAt = at;
    }
    const status = runs[0]?.status;
    if (status === undefined) throw new Error(`run ${this.runId} is gone`);
    if (status !== this.status) {
      this.status = status;
      this.changes.push({ status, at });
    }
    if (
      this.final.seen === undefined &&
      startedAt > this.final.after &&
      status !== "running"
    ) {
      this.final.seen = { status, at };
    }
  }
}

export interface QueueProbe {
  /** Waiting, active and delayed jobs (a retry waits in `delayed`). */
  busy(): Promise<number>;
  /**
   * True once two polls in a row (`POLL_MS` apart) find no job waiting,
   * active or delayed; false when `timeoutMs` passes with the queue busy.
   */
  waitIdle(timeoutMs: number): Promise<boolean>;
  /** Removes every waiting and delayed job; active ones run to the end. */
  dropWaiting(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The diff queue under the harness's prefix, read with `getJobCounts`. The
 * harness is the only producer, so an idle queue means no diff is in flight.
 */
export function openQueueProbe(
  alive: () => void = () => undefined,
): QueueProbe {
  const queue = createQueue("diff", { prefix: QUEUE_PREFIX });
  // BullMQ leaves the connection it was handed open: release it on close,
  // without ever awaiting `queue.client` there (it settles only once the
  // connection is ready).
  let client: { disconnect(): void } | undefined;
  let closed = false;
  void queue.client.then(
    (c) => {
      client = c;
      if (closed) c.disconnect();
    },
    () => undefined,
  );

  const busy = async (): Promise<number> => {
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  };

  return {
    busy,
    async waitIdle(timeoutMs) {
      const deadline = performance.now() + timeoutMs;
      let idlePolls = 0;
      for (;;) {
        alive();
        idlePolls = (await busy()) === 0 ? idlePolls + 1 : 0;
        if (idlePolls >= 2) return true;
        // An idle reading always gets its confirming poll.
        if (idlePolls === 0 && performance.now() >= deadline) return false;
        await sleep(POLL_MS);
      }
    },
    async dropWaiting() {
      await queue.drain(true);
    },
    close: once(async () => {
      closed = true;
      try {
        await queue.close();
      } finally {
        client?.disconnect();
      }
    }),
  };
}

/**
 * Subscribes a dedicated connection (a subscribed connection can run nothing
 * else) to one channel, handing each message and its arrival time to
 * `onMessage`. Returns the idempotent close.
 */
async function subscribeChannel(
  redis: Redis,
  channel: string,
  onMessage: (message: string, at: number) => void,
): Promise<() => Promise<void>> {
  const sub = redis.duplicate();
  sub.on("message", (from: string, message: string) => {
    if (from === channel) onMessage(message, performance.now());
  });
  const close = once(() => releaseRedis(sub));
  try {
    await sub.subscribe(channel);
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}

function parseJson(message: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(message);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ProjectEvents {
  /** Events named `event` whose `data.id` is `id`, received so far. */
  count(event: string, id: string): number;
  close(): Promise<void>;
}

/**
 * Counts the project's raw live events (`project:<id>:events:raw`,
 * `apps/api/src/lib/broadcast.ts`) by name and `data.id`.
 */
export async function subscribeProjectEvents(
  redis: Redis,
  projectId: string,
): Promise<ProjectEvents> {
  const counts = new Map<string, number>();
  const key = (event: string, id: string): string => `${event}\u0000${id}`;
  const close = await subscribeChannel(
    redis,
    `project:${projectId}:events:raw`,
    (message) => {
      const parsed = parseJson(message);
      if (typeof parsed?.event !== "string") return;
      const data = parsed.data as { id?: unknown } | null | undefined;
      const k = key(parsed.event, typeof data?.id === "string" ? data.id : "");
      counts.set(k, (counts.get(k) ?? 0) + 1);
    },
  );
  return { count: (event, id) => counts.get(key(event, id)) ?? 0, close };
}

export interface RunStatuses {
  /** Each diff job's post-rollup status, with its arrival time. */
  seen(): { at: number; status: string }[];
  close(): Promise<void>;
}

/**
 * The run's own channel (`run:<id>:events`), where every diff job publishes
 * `run.completed` with the status its rollup derived (top-level `status`,
 * `apps/diff-worker/src/handler.ts`). The api's `/complete` publishes a
 * `run.completed` too, with the status it read nested in `payload`; that one
 * is not a diff result and is skipped.
 */
export async function subscribeRunStatuses(
  redis: Redis,
  runId: string,
): Promise<RunStatuses> {
  const seen: { at: number; status: string }[] = [];
  const close = await subscribeChannel(
    redis,
    `run:${runId}:events`,
    (message, at) => {
      const parsed = parseJson(message);
      if (
        parsed?.type === "run.completed" &&
        typeof parsed.status === "string"
      ) {
        seen.push({ at, status: parsed.status });
      }
    },
  );
  return { seen: () => seen.map((s) => ({ ...s })), close };
}
