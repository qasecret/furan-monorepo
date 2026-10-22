import {
  BUDGETS,
  evaluate,
  exitCode,
  type Measurement,
  type Suite,
} from "./budgets.js";
import {
  USAGE,
  UsageError,
  parseCliArgs,
  runOrder,
  type CliArgs,
} from "./cli-args.js";
import { loginOnce, mintJwt, verifyAuth } from "./clients/http.js";
import { ScaleEnvError, parseScaleEnv } from "./env.js";
import { InterruptedError, describeError } from "./errors.js";
import { runSuiteGuarded } from "./guard.js";
import { writeReport } from "./report.js";
import {
  createScratch,
  markSeedUsed,
  seed,
  shapes,
  type Seeded,
  type Shape,
} from "./seed/index.js";
import { openDataPlane, startStack, type Stack } from "./stack/api.js";
import { buildDashboard, startDashboard } from "./stack/dashboard.js";
import { startProxy } from "./stack/proxy.js";
import { Teardown, closeInOrder } from "./stack/teardown.js";
import { runBrowserSuite } from "./suites/browser.js";
import { runPipelineSuite } from "./suites/pipeline.js";
import { loadViewerCalls, runServerSuite } from "./suites/server.js";

/** What a suite runner gets: the running stack, what was seeded, and the flags. */
export interface SuiteContext {
  stack: Stack;
  seeded: Seeded;
  shape: Shape;
  args: CliArgs;
  /**
   * The one origin the browser suite drives: the production dashboard and the
   * api behind a single proxy, as nginx serves them. Set when the browser
   * suite is selected.
   */
  proxyUrl?: string | undefined;
  /**
   * The procedures the viewer called on open, when the browser suite recorded
   * them earlier in this run; the server suite's R4 falls back to the
   * checked-in list without them.
   */
  recordedViewerCalls?: string[];
}

/**
 * The suites that can run. A suite with no runner is reported as `error` on all
 * of its budgets, so the run fails instead of passing on nothing: each suite's
 * task adds its runner here.
 */
const RUNNERS: Partial<
  Record<Suite, (ctx: SuiteContext) => Promise<Measurement[]>>
> = {
  // Runs first (Ruling R25), so the server suite's R4 measures the call set
  // the viewer was just seen to request.
  browser: async (ctx) => {
    if (ctx.proxyUrl === undefined) {
      throw new Error("the browser suite needs the dashboard, which is not up");
    }
    const { measurements, viewerCalls } = await runBrowserSuite(
      ctx.stack,
      ctx.seeded,
      ctx.proxyUrl,
      { shape: ctx.shape, outDir: ctx.args.report },
    );
    if (viewerCalls !== undefined) ctx.recordedViewerCalls = viewerCalls;
    return measurements;
  },
  pipeline: ({ stack, seeded, shape }) =>
    runPipelineSuite(stack, seeded, shape),
  server: ({ stack, seeded, recordedViewerCalls }) => {
    // A drifted call set fails the suite: R4 must measure the real viewer.
    const { calls, source } = loadViewerCalls(recordedViewerCalls);
    return runServerSuite(stack, seeded, calls, { callSetSource: source });
  },
};

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const warn = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface RunState {
  /** Set by the first SIGINT/SIGTERM. */
  interrupted: boolean;
}

/** Exit status: 1 = failed run, 2 = bad flags or environment, 130/143 = signalled. */
async function run(
  args: CliArgs,
  teardown: Teardown,
  state: RunState,
): Promise<number> {
  const shape = shapes[args.shape];
  const env = parseScaleEnv(process.env, { storage: args.storage });
  // Checked after each phase: once a signal has started the teardown, the main
  // flow stops instead of opening more.
  const stillRunning = (): void => {
    if (state.interrupted) throw new InterruptedError();
  };

  say(`creating and migrating the scratch database`);
  const scratch = await createScratch(env.databaseUrl);
  // One step, so the database is dropped while the lock is still held.
  teardown.add(
    args.keep ? "release the scratch lock" : "drop the scratch database",
    () =>
      closeInOrder(
        async () => {
          if (!args.keep) await scratch.drop();
        },
        () => scratch.release(),
      ),
  );
  stillRunning();

  // The browser suite drives a production build of the dashboard. It is built
  // here, after the scratch lock is held (so a second run cannot build into the
  // same directory) and before the seed, so a failed build fails fast.
  const needsBrowser = args.suites.includes("browser");
  const built = needsBrowser
    ? await buildDashboard({ noBuild: args.noBuild, teardown })
    : undefined;
  stillRunning();

  const plane = await openDataPlane(
    env,
    scratch.url,
    { storage: args.storage, keep: args.keep, reuse: args.reuse },
    teardown,
  );
  stillRunning();

  say(
    `seeding the ${shape.name} shape${args.reuse ? " (--reuse: a current seed is kept)" : ""}`,
  );
  const seedStarted = performance.now();
  const seeded = await seed(plane.db, shape, plane.storage, {
    // A kept seed refers to the objects of the run that made it.
    reuse: args.reuse && plane.storageReused,
  });
  say(`seeded in ${((performance.now() - seedStarted) / 1000).toFixed(1)}s`);
  stillRunning();

  const stack = await startStack(env, scratch.url, {
    storage: args.storage,
    teardown,
    plane,
  });
  say(`api and diff worker up on ${stack.apiUrl}`);
  stillRunning();

  let proxyUrl: string | undefined;
  if (built !== undefined) {
    const dashboard = await startDashboard(built.standaloneDir, stack.apiUrl, {
      teardown,
    });
    stillRunning();
    const proxy = await startProxy(stack.apiUrl, dashboard.url, teardown);
    proxyUrl = proxy.url;
    say(`dashboard up on ${dashboard.url}; browser origin ${proxy.url}`);
    stillRunning();
  }

  // The one real login is reviewer 0's (the only seeded user with a password);
  // every other token is minted.
  const loggedIn = await loginOnce(
    stack.apiUrl,
    seeded.browserLogin.email,
    seeded.browserLogin.password,
  );
  await verifyAuth(stack.apiUrl, {
    minted: mintJwt(stack.app, { id: seeded.adminId, role: "admin" }),
    loggedIn,
  });
  stillRunning();

  const measurements: Measurement[] = [];
  const ctx: SuiteContext = { stack, seeded, shape, args, proxyUrl };
  // Ruling R25: always browser, then server, then pipeline (see SUITE_ORDER).
  const suites = runOrder(args.suites);
  if (suites.length > 0) {
    // Ruling R26: every suite changes the seeded project (approves, new
    // batches), so once one starts the seed is no longer the shape it claims.
    // Cleared here, once, before the first suite: the next --reuse reseeds. A
    // run that ends before any suite starts leaves the seed reusable.
    await markSeedUsed(plane.db);
  }
  for (const suite of suites) {
    const runner = RUNNERS[suite];
    say(`suite ${suite}`);
    measurements.push(
      ...(await runSuiteGuarded(
        suite,
        runner === undefined ? undefined : () => runner(ctx),
      )),
    );
    stillRunning();
  }

  const rows = evaluate(BUDGETS, measurements, args.suites);
  const written = writeReport(
    rows,
    { shape: shape.name, suites: args.suites },
    args.report,
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  }
  say(
    `verdicts: ${[...counts].map(([verdict, n]) => `${verdict} ${n}`).join(", ")}`,
  );
  for (const row of rows) {
    if (row.verdict === "error" || row.verdict === "missing") {
      say(`  ${row.id}: ${row.verdict}${row.note ? ` (${row.note})` : ""}`);
    }
  }
  say(`report: ${written.md}`);
  if (args.keep) {
    say(`kept: the furan_scale database and its storage (see --reuse)`);
  }
  return exitCode(rows, shape.name);
}

/** Exit status of a failed `run`: 2 for bad flags or environment, else 1. */
function statusOf(error: unknown): number {
  return error instanceof UsageError || error instanceof ScaleEnvError ? 2 : 1;
}

/** Prints the teardown steps that failed: a leak is never silent. */
function reportTeardown(
  results: readonly { name: string; error?: string }[],
): void {
  for (const result of results) {
    if (result.error !== undefined) {
      warn(`teardown: ${result.name} failed: ${result.error}`);
    }
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    warn(describeError(error));
    warn(USAGE);
    process.exit(2);
  }

  const teardown = new Teardown();
  const state: RunState = { interrupted: false };
  let finished: Promise<unknown> = Promise.resolve();

  // The first signal closes everything (the scratch database and storage
  // included, unless --keep), then exits; a second one exits at once.
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signals += 1;
    if (signals > 1) {
      warn(`\n${signal} again: exiting without waiting for the cleanup`);
      process.exit(130);
    }
    state.interrupted = true;
    warn(`\n${signal}: cleaning up (send it again to exit at once)`);
    void teardown
      .run()
      .then(async (results) => {
        // Give the main flow a moment to unwind: whatever it opens meanwhile
        // is closed at once (see Teardown.add).
        await Promise.race([
          finished.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        reportTeardown([...results, ...(await teardown.lateResults())]);
      })
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let code = 1;
  finished = run(args, teardown, state).then(
    (c) => {
      code = c;
    },
    (error: unknown) => {
      // After a signal the failure is a consequence (a closed connection):
      // the signal handler has already said what is happening.
      if (error instanceof InterruptedError || state.interrupted) return;
      warn(`scale: ${describeError(error)}`);
      code = statusOf(error);
    },
  );
  await finished;

  const results = [
    ...(await teardown.run()),
    ...(await teardown.lateResults()),
  ];
  // After a signal the handler owns the report and the exit.
  if (state.interrupted) return;
  reportTeardown(results);
  const failed = results.some((r) => r.error !== undefined);
  // A failed cleanup can leave furan_scale or a bucket behind: not a clean run.
  process.exit(failed && code === 0 ? 1 : code);
}

void main();
