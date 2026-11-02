import {
  isPassing,
  type CheckOptions,
  type Furan,
  type FuranTest,
  type TestResult,
} from "@furan/client";

import type { UploadArgs } from "./args.js";
import { createLimit } from "./limit.js";
import type { PlannedStep, PlannedTest } from "./scan.js";

export interface UploadDeps {
  furan: Furan;
  readFile: (path: string) => Promise<Uint8Array>;
  /** Progress lines (stderr). */
  log: (line: string) => void;
  signal?: AbortSignal;
}

export interface UploadReport {
  buildId: string;
  buildUrl: string | null;
  branch: string;
  /** The verdict wait budget, for the timeout hint. */
  timeoutSeconds: number;
  tests: TestResult[];
  exitCode: 0 | 1 | 3;
}

/**
 * Upload the plan (spec §5.3): open the build, open each test and upload its
 * steps (at most `concurrency` requests at a time), complete each test after
 * its last step, then wait for every verdict under one deadline. On an error
 * or an abort, every test still open is aborted before the error is rethrown.
 */
export async function runUpload(
  plan: PlannedTest[],
  args: UploadArgs,
  deps: UploadDeps,
): Promise<UploadReport> {
  const { furan, signal } = deps;
  const limit = createLimit(args.concurrency);
  const build = await furan.openBuild();
  const stepCount = plan.reduce((n, t) => n + t.steps.length, 0);
  deps.log(
    `furan: uploading ${stepCount} step${stepCount === 1 ? "" : "s"} in ${plan.length} test${plan.length === 1 ? "" : "s"} to ${build.url ?? `batch ${build.id}`}`,
  );

  const opened: FuranTest[] = [];
  // The first failure halts the rest: queued work checks `halted` before it
  // starts, so a dead api costs one request's retries, not one per step.
  const halt = new AbortController();
  const stopIfHalted = (): void => {
    signal?.throwIfAborted();
    halt.signal.throwIfAborted();
  };
  const guarded = <T>(fn: () => Promise<T>): Promise<T> =>
    limit(async () => {
      stopIfHalted();
      try {
        return await fn();
      } catch (err) {
        if (!halt.signal.aborted) halt.abort(err);
        throw err;
      }
    });
  let tests: FuranTest[];
  try {
    tests = await settleAll(
      plan.map((planned) =>
        guarded(async () => {
          const test = await build.openTest(planned.name);
          opened.push(test);
          return test;
        }),
      ),
    );
    await settleAll(
      plan.map(async (planned, i) => {
        const test = tests[i]!;
        await settleAll(
          planned.steps.map((step) =>
            guarded(async () => {
              const png = await deps.readFile(step.file);
              await test.check(step.name, png, checkOptions(step, args));
            }),
          ),
        );
        stopIfHalted();
        await test.complete();
      }),
    );
  } catch (err) {
    await Promise.all(opened.map((t) => t.abort()));
    throw err;
  }

  let results: TestResult[];
  if (!args.wait) {
    results = await Promise.all(tests.map((t) => t.close({ wait: false })));
  } else {
    deps.log("furan: waiting for verdicts…");
    const deadline = Date.now() + furan.config.timeoutMs;
    results = await Promise.all(
      tests.map((t) =>
        limit(() => t.result({ deadline, ...(signal ? { signal } : {}) })),
      ),
    );
  }

  return {
    buildId: build.id,
    buildUrl: build.url,
    branch: furan.config.branch,
    timeoutSeconds: Math.round(furan.config.timeoutMs / 1000),
    tests: results,
    exitCode: exitCodeFor(results, furan.config.failOnNew),
  };
}

/** A step's upload options: flags for every step, then its sidecar. */
function checkOptions(step: PlannedStep, args: UploadArgs): CheckOptions {
  const sidecar = step.sidecar ?? {};
  const options: CheckOptions = {
    ignore: [...args.ignore, ...(sidecar.ignore ?? [])],
  };
  if (sidecar.layout) options.layout = sidecar.layout;
  if (sidecar.content) options.content = sidecar.content;
  if (sidecar.floating) options.floating = sidecar.floating;
  const matchLevel = sidecar.matchLevel ?? args.matchLevel;
  if (matchLevel) options.matchLevel = matchLevel;
  if (args.viewport) options.viewport = args.viewport;
  if (args.browser) options.browser = args.browser;
  if (args.os) options.os = args.os;
  if (args.device) options.device = args.device;
  return options;
}

/**
 * Await every promise (so nothing is still in flight), then throw the first
 * failure, if any.
 */
async function settleAll<T>(promises: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find(
    (s): s is PromiseRejectedResult => s.status === "rejected",
  );
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

/** Spec §5.4: 1 when a test needs review, else 3 when one had no verdict, else 0. */
export function exitCodeFor(
  results: TestResult[],
  failOnNew: boolean,
): 0 | 1 | 3 {
  if (
    results.some((r) => r.status !== "error" && !isPassing(r.status, failOnNew))
  ) {
    return 1;
  }
  return results.some((r) => r.status === "error") ? 3 : 0;
}

/** The `status` GitHub output: one word for the whole upload. */
export function overallStatus(
  results: TestResult[],
  failOnNew: boolean,
): "passed" | "new" | "failed" | "error" | "uploaded" {
  if (
    results.some((r) => r.status !== "error" && !isPassing(r.status, failOnNew))
  ) {
    return "failed";
  }
  if (results.some((r) => r.status === "error")) return "error";
  if (results.some((r) => r.status === "new")) return "new";
  if (results.length > 0 && results.every((r) => r.status === "uploaded")) {
    return "uploaded";
  }
  return "passed";
}
