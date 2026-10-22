import { describeError } from "../errors.js";

export interface TeardownResult {
  name: string;
  error?: string;
}

interface Step {
  name: string;
  fn: () => Promise<void>;
}

export interface TeardownOptions {
  /** A step still running after this long is abandoned and reported. */
  stepTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;

/**
 * Everything the harness opens registers how to close it here, as it opens it.
 * `run()` closes in reverse order: the newest first, so the worker stops before
 * the api, the api before the connections it uses, and the scratch database is
 * dropped after all of them.
 *
 * - Every step runs exactly once; a second `run()` runs nothing and returns the
 *   first run's results (a caller that arrives while it is in progress waits
 *   for it).
 * - A step that throws, or outlives its timeout, is reported and the steps
 *   after it still run.
 * - A step added once `run()` has begun (the main flow opened something just as
 *   a signal arrived) runs at once, so it is never leaked.
 */
export class Teardown {
  private readonly steps: Step[] = [];
  private readonly late: Promise<TeardownResult>[] = [];
  private readonly stepTimeoutMs: number;
  private started = false;
  private ran: Promise<TeardownResult[]> | undefined;

  constructor(options: TeardownOptions = {}) {
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  add(name: string, fn: () => Promise<void>): void {
    if (this.started) {
      this.late.push(this.execute({ name, fn }));
      return;
    }
    this.steps.push({ name, fn });
  }

  /** True from the moment `run()` is first called. */
  get closing(): boolean {
    return this.started;
  }

  run(): Promise<TeardownResult[]> {
    this.started = true;
    this.ran ??= this.drain();
    return this.ran;
  }

  /** The results of the steps added after `run()` began, once they finish. */
  lateResults(): Promise<TeardownResult[]> {
    return Promise.all(this.late);
  }

  private async drain(): Promise<TeardownResult[]> {
    const results: TeardownResult[] = [];
    for (let step = this.steps.pop(); step; step = this.steps.pop()) {
      results.push(await this.execute(step));
    }
    return results;
  }

  /** Never rejects: a failure is part of the result. */
  private async execute(step: Step): Promise<TeardownResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        step.fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`timed out after ${this.stepTimeoutMs / 1000}s`),
              ),
            this.stepTimeoutMs,
          );
        }),
      ]);
      return { name: step.name };
    } catch (error) {
      return { name: step.name, error: describeError(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Runs `steps` one after another, every one even when an earlier one throws,
 * and rethrows the first failure. For resources that depend on each other
 * (clear the Redis keys, then close Redis): they register as ONE teardown step,
 * so a step added after a signal (which runs at once) cannot close the
 * dependency first.
 */
export async function closeInOrder(
  ...steps: Array<() => Promise<unknown>>
): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}
