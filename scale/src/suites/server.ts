import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { asc, eq, screenshots, testRuns } from "@furan/db";

import { BUDGETS, type Measurement } from "../budgets.js";
import { mintJwt, trpc, type TrpcResult } from "../clients/http.js";
import { readHistogram } from "../clients/metrics.js";
import { InterruptedError, describeError } from "../errors.js";
import { pendingSteps, type Seeded } from "../seed/index.js";
import type { Stack } from "../stack/api.js";

import {
  disjointSlices,
  failedRequests,
  measureCalls,
  serverMinusStorage,
  type CallSample,
} from "./server-math.js";
import { runSolo } from "./solo.js";
import type { ViewerCall, ViewerTarget } from "./viewer-calls.js";

export {
  FALLBACK_VIEWER_PATHS,
  ViewerCallDriftError,
  loadViewerCalls,
  type ViewerCall,
  type ViewerTarget,
} from "./viewer-calls.js";
export { runSolo } from "./solo.js";

/**
 * The server suite (spec §5.3): R1–R8 over HTTP against the in-process api,
 * and the R1-solo / R2-solo rows through the previous perf script's method.
 *
 * Order:
 * 1. **Solo** (`runSolo`), alone, on the review queue as seeded.
 * 2. **The reviewers.** One per seeded reviewer (20 in `large`), each with a
 *    minted JWT, loop through a review session at once: a 10 s warm-up, then
 *    a 60 s window whose calls are measured. The window stays open until the
 *    probe below is done, so R4 and R6 are measured under the same load.
 * 3. **The probe**, a further client started when the window opens: R4 (the
 *    viewer call set, 5 warm-up passes and 50 measured) then R6 (the storage
 *    proxy, 5 warm-ups and 50 measured).
 * 4. **R8**, from the api's HTTP histogram once everything is done.
 *
 * Every procedure is called on its own unbatched HTTP call and timed on the
 * client, so a p95 belongs to exactly one procedure. Approves (R7) happen only
 * inside the window, each reviewer from its own slice of the newest batch's
 * pending steps: a warm-up approve would use up steps the window needs (the
 * smoke seed has three). A phase that fails marks only its own budgets
 * `error`.
 */

/** The reviewers' warm-up, whose calls are not measured. */
const WARMUP_MS = 10_000;
/** The measured window (at least; it stays open until the probe is done). */
const WINDOW_MS = 60_000;
/** The probe's warm-up passes, then its measured ones (spec §2.1). */
const PROBE_WARMUP = 5;
const PROBE_CALLS = 50;
const HTTP_METRIC = "furan_http_request_duration_seconds";
/** The storage proxy's route template, its `route` label. */
const STORAGE_ROUTE = "/api/v1/storage/:key";
/** How long the api has to observe a storage GET after its body arrived. */
const OBSERVE_TIMEOUT_MS = 2_000;

const SOLO_IDS = [
  "R1-solo.findNext",
  "R1-solo.reviewNext",
  "R1-solo.worst",
  "R2-solo.pendingCount",
  "R2-solo.runsListPending",
  "R2-solo.buildsListNeedsReview",
  "R2-solo.worst",
] as const;
const LOOP_IDS = [
  "R1",
  "R2.pendingCount",
  "R2.runsListPending",
  "R3.buildsList",
  "R3.buildsListNeedsReview",
  "R3.runsList",
  "R5.buildsGetById",
  "R5.checkpointGroup",
  "R7",
] as const;
/** Every budget of the suite, in report order (`budgets.ts` is the source). */
const IDS = BUDGETS.filter((b) => b.suite === "server").map((b) => b.id);

/**
 * Each loop budget and the sample keys it pools. A key is the procedure path,
 * or the path and a variant where one procedure is called two ways.
 */
const LOOP_BUDGETS: Readonly<Record<(typeof LOOP_IDS)[number], string[]>> = {
  // From the batch page ("Start reviewing") and from the viewer's step.
  R1: ["review.next"],
  "R2.pendingCount": ["builds.pendingCount"],
  "R2.runsListPending": ["runs.list pending"],
  "R3.buildsList": ["builds.list"],
  "R3.buildsListNeedsReview": ["builds.list needsReview"],
  "R3.runsList": ["runs.list"],
  // The batch page's and the viewer's: both on the newest batch.
  "R5.buildsGetById": ["builds.getById"],
  "R5.checkpointGroup": ["runs.getCheckpointGroup"],
  R7: ["review.approve"],
};

export interface ServerSuiteOptions {
  /** Where `viewerCalls` came from, for R4's note. */
  callSetSource?: "recorded" | "fallback";
}

export async function runServerSuite(
  stack: Stack,
  seeded: Seeded,
  viewerCalls: ViewerCall[],
  opts: ServerSuiteOptions = {},
): Promise<Measurement[]> {
  const out = new Map<string, Measurement>();
  const failed = (ids: readonly string[], error: unknown): void => {
    if (error instanceof InterruptedError || stack.teardown.closing) {
      throw error;
    }
    for (const id of ids) {
      out.set(id, { id, value: null, error: describeError(error) });
    }
  };
  // Every call any client made (warm-ups and the probe included), for R8.
  const statuses: { status: number }[] = [];

  try {
    for (const m of await runSolo(stack, seeded)) out.set(m.id, m);
  } catch (error) {
    failed(SOLO_IDS, error);
  }

  try {
    const measured = await runReviewers(stack, seeded, viewerCalls, {
      source: opts.callSetSource ?? "fallback",
      statuses,
    });
    for (const m of measured) out.set(m.id, m);
  } catch (error) {
    failed([...LOOP_IDS, "R4.time", "R4.size", "R6"], error);
  }

  try {
    const { count } = await readHistogram(stack.registries.api, HTTP_METRIC, {
      status_class: "5xx",
    });
    const r8 = failedRequests(count, statuses);
    out.set("R8", {
      id: "R8",
      value: r8.value,
      samples: statuses.length,
      note: `${r8.note}, over ${statuses.length} server-suite calls (the histogram covers every suite run so far)`,
    });
  } catch (error) {
    failed(["R8"], error);
  }

  return IDS.map(
    (id) => out.get(id) ?? { id, value: null, error: "not measured" },
  );
}

// ---------------------------------------------------------------------------
// The reviewers
// ---------------------------------------------------------------------------

interface Reviewer {
  client: ReturnType<typeof trpc>;
  /** The newest batch's pending steps this reviewer approves, in order. */
  slice: ViewerTarget[];
  /** The next of them to approve. */
  next: number;
  /** Approves the api accepted. */
  approved: number;
  /** Passes started inside the window. */
  passes: number;
}

interface Recorder {
  /** Calls started inside the window. */
  samples: CallSample[];
  statuses: { status: number }[];
  /** Set once the warm-up is over; calls started earlier are not measured. */
  measuring: boolean;
  /** Set when the window closes, or a reviewer fails: the loops end. */
  stopped: boolean;
  alive: () => void;
}

/** One HTTP call, recorded. A call that got no response is status 0. */
async function record(
  rec: Recorder,
  send: () => Promise<TrpcResult>,
  key: string,
): Promise<TrpcResult | undefined> {
  rec.alive();
  const measured = rec.measuring && !rec.stopped;
  const started = performance.now();
  let res: TrpcResult | undefined;
  try {
    res = await send();
  } catch {
    // No response (reset, refused): R8 counts it.
  }
  const sample: CallSample = {
    key,
    ms: res?.ms ?? performance.now() - started,
    status: res?.status ?? 0,
    bytes: res?.bytes ?? 0,
  };
  rec.statuses.push({ status: sample.status });
  if (measured) rec.samples.push(sample);
  return res;
}

/** The step every viewer opens on when its reviewer has nothing to decide. */
async function firstStepOf(
  stack: Stack,
  projectId: string,
  buildId: string,
): Promise<ViewerTarget> {
  const [row] = await stack.db
    .select({ runId: testRuns.id, checkpointId: screenshots.id })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(eq(testRuns.buildId, buildId))
    .orderBy(
      asc(testRuns.createdAt),
      asc(testRuns.id),
      asc(screenshots.createdAt),
      asc(screenshots.id),
    )
    .limit(1);
  if (!row) throw new Error("the newest batch has no step");
  return { projectId, buildId, ...row };
}

/** The ids of the runs on a `runs.list` page. */
function runIdsOf(res: TrpcResult | undefined): string[] {
  const items = (res?.data as { items?: { id?: unknown }[] } | undefined)
    ?.items;
  return (items ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string");
}

/**
 * One pass of the review session (spec §5.3), as the dashboard asks for it.
 * `rec.measuring` decides whether its calls count; the approve waits for it.
 */
async function iteration(
  r: Reviewer,
  rec: Recorder,
  seeded: Seeded,
  viewerCalls: ViewerCall[],
  fallback: ViewerTarget,
): Promise<void> {
  const projectId = seeded.projectId;
  const buildId = seeded.newestBuildId;
  if (rec.measuring && !rec.stopped) r.passes += 1;
  const query = (key: string, path: string, input: unknown) =>
    record(rec, () => r.client.query(path, input), key);

  // 1. The Batches page: the list ("All", and the default "Needs review"
  //    view) and the pending badge every page shows.
  await query("builds.list", "builds.list", { projectId });
  await query("builds.list needsReview", "builds.list", {
    projectId,
    needsReview: true,
  });
  await query("builds.pendingCount", "builds.pendingCount", { projectId });

  // 2. The newest batch: the batch, its runs (the default "Needs review"
  //    view, and unfiltered), and each listed run's steps (every row the page
  //    renders asks for its own).
  await query("builds.getById", "builds.getById", { buildId });
  const page = await query("runs.list pending", "runs.list", {
    projectId,
    buildId,
    order: "capture",
    pending: true,
  });
  await query("runs.list", "runs.list", {
    projectId,
    buildId,
    order: "capture",
  });
  for (const runId of runIdsOf(page)) {
    await query("runs.listCheckpoints", "runs.listCheckpoints", { runId });
  }

  // 3. The viewer, on the step this reviewer decides next (or, its slice
  //    used up, the last one it decided).
  const target = r.slice[r.next] ?? r.slice[r.slice.length - 1] ?? fallback;
  for (const call of viewerCalls) {
    await query(call.path, call.path, call.inputAt(target));
  }

  // 4. Where the review goes next, from the batch ("Start reviewing").
  await query("review.next", "review.next", { projectId, at: { buildId } });

  // 5. Approve that step: measured calls only, and never a step twice.
  const step = r.slice[r.next];
  if (step !== undefined && rec.measuring && !rec.stopped) {
    r.next += 1;
    const res = await record(
      rec,
      () =>
        r.client.mutation("review.approve", {
          runId: step.runId,
          actionId: randomUUID(),
          checkpointIds: [step.checkpointId],
        }),
      "review.approve",
    );
    if (res?.status === 200) r.approved += 1;
  }
}

/** Sleeps until `deadline`, waking early when the loops stop or the run ends. */
async function waitUntil(deadline: number, rec: Recorder): Promise<void> {
  while (!rec.stopped && performance.now() < deadline) {
    rec.alive();
    await sleep(Math.min(250, Math.max(1, deadline - performance.now())));
  }
}

async function runReviewers(
  stack: Stack,
  seeded: Seeded,
  viewerCalls: ViewerCall[],
  opts: { source: "recorded" | "fallback"; statuses: { status: number }[] },
): Promise<Measurement[]> {
  if (seeded.reviewers.length === 0) {
    throw new Error("the seed has no reviewers");
  }
  const pending: ViewerTarget[] = (
    await pendingSteps(stack.db, seeded.projectId)
  )
    .filter((p) => p.buildId === seeded.newestBuildId)
    .map((p) => ({ projectId: seeded.projectId, ...p }));
  const fallback = await firstStepOf(
    stack,
    seeded.projectId,
    seeded.newestBuildId,
  );
  const reviewers: Reviewer[] = disjointSlices(
    pending,
    seeded.reviewers.length,
  ).map((slice, i) => ({
    client: trpc(
      stack.apiUrl,
      mintJwt(stack.app, { id: seeded.reviewers[i]!.id, role: "editor" }),
    ),
    slice,
    next: 0,
    approved: 0,
    passes: 0,
  }));

  const rec: Recorder = {
    samples: [],
    statuses: opts.statuses,
    measuring: false,
    stopped: false,
    alive: () => {
      if (stack.teardown.closing) throw new InterruptedError();
    },
  };
  const errors: unknown[] = [];
  const loops = reviewers.map((r) =>
    (async () => {
      while (!rec.stopped) {
        await iteration(r, rec, seeded, viewerCalls, fallback);
      }
    })().catch((error: unknown) => {
      // Never unhandled: kept, and the other loops stop.
      errors.push(error);
      rec.stopped = true;
    }),
  );

  let probed: Measurement[] = [];
  let windowMs = 0;
  try {
    const started = performance.now();
    await waitUntil(started + WARMUP_MS, rec);
    // A reviewer that failed in the warm-up has stopped them all: no window.
    if (!rec.stopped) {
      rec.measuring = true;
      const opened = performance.now();
      probed = await runProbe(stack, seeded, viewerCalls, rec, opts.source);
      await waitUntil(opened + WINDOW_MS, rec);
      windowMs = performance.now() - opened;
    }
  } finally {
    rec.stopped = true;
    await Promise.all(loops);
  }
  if (errors.length > 0) throw errors[0];

  const passes = reviewers.map((r) => r.passes);
  const approved = reviewers.reduce((sum, r) => sum + r.approved, 0);
  const load = `${reviewers.length} reviewers at once, ${(windowMs / 1000).toFixed(1)} s measured after a ${WARMUP_MS / 1000} s warm-up, ${Math.min(...passes)}–${Math.max(...passes)} measured passes each`;
  const loop = LOOP_IDS.map((id) => {
    const m = measureCalls(id, rec.samples, LOOP_BUDGETS[id]);
    return { ...m, note: `${m.note}; ${load}` };
  });
  const r7 = loop.find((m) => m.id === "R7")!;
  r7.note = `${r7.note}; approved ${approved} of the newest batch's ${pending.length} pending steps, each reviewer from its own slice`;
  if (pending.length === 0) {
    r7.error = "the newest batch has no pending step to approve";
  }
  return [...loop, ...probed];
}

// ---------------------------------------------------------------------------
// The probe: R4 and R6, under the reviewers' load
// ---------------------------------------------------------------------------

async function runProbe(
  stack: Stack,
  seeded: Seeded,
  viewerCalls: ViewerCall[],
  rec: Recorder,
  source: "recorded" | "fallback",
): Promise<Measurement[]> {
  const reviewer = seeded.reviewers[0]!;
  // A reviewer (`editor`): R6 is the access check of a non-admin.
  const token = mintJwt(stack.app, { id: reviewer.id, role: "editor" });
  const out: Measurement[] = [];
  try {
    out.push(
      ...(await measureViewerOpen(
        stack,
        seeded,
        viewerCalls,
        token,
        rec,
        source,
      )),
    );
  } catch (error) {
    if (error instanceof InterruptedError) throw error;
    out.push(
      ...["R4.time", "R4.size"].map((id) => ({
        id,
        value: null,
        error: describeError(error),
      })),
    );
  }
  try {
    out.push(await measureStorageProxy(stack, seeded, token, rec));
  } catch (error) {
    if (error instanceof InterruptedError) throw error;
    out.push({ id: "R6", value: null, error: describeError(error) });
  }
  return out;
}

/**
 * R4: every procedure of the viewer call set on step 1 of the long run, one
 * pass after another (5 warm-ups, then 50). R4.time is the slowest
 * procedure's p95; R4.size the decoded JSON of the largest measured pass.
 */
async function measureViewerOpen(
  stack: Stack,
  seeded: Seeded,
  viewerCalls: ViewerCall[],
  token: string,
  rec: Recorder,
  source: "recorded" | "fallback",
): Promise<Measurement[]> {
  if (viewerCalls.length === 0) {
    throw new Error("the viewer call set is empty");
  }
  const client = trpc(stack.apiUrl, token);
  const samples: CallSample[] = [];
  let largest: { bytes: number; byPath: Map<string, number> } | undefined;
  for (let pass = 0; pass < PROBE_WARMUP + PROBE_CALLS; pass++) {
    const byPath = new Map<string, number>();
    let complete = true;
    for (const call of viewerCalls) {
      rec.alive();
      let res: TrpcResult | undefined;
      try {
        res = await client.query(call.path, call.input(seeded));
      } catch {
        // No response: R8 counts it.
      }
      const status = res?.status ?? 0;
      rec.statuses.push({ status });
      if (status !== 200) complete = false;
      byPath.set(call.path, res?.bytes ?? 0);
      if (pass >= PROBE_WARMUP) {
        samples.push({
          key: call.path,
          ms: res?.ms ?? 0,
          status,
          bytes: res?.bytes ?? 0,
        });
      }
    }
    const bytes = [...byPath.values()].reduce((a, b) => a + b, 0);
    if (
      pass >= PROBE_WARMUP &&
      complete &&
      (largest === undefined || bytes > largest.bytes)
    ) {
      largest = { bytes, byPath };
    }
  }

  const perPath = viewerCalls.map((call) =>
    measureCalls("R4.time", samples, [call.path]),
  );
  const refused = perPath.find((m) => m.error !== undefined);
  const values = perPath.map((m) => m.value);
  const slowest = values.every((v) => v !== null)
    ? Math.max(...(values as number[]))
    : null;
  const failures = samples.filter((s) => s.status !== 200).length;
  const pathTimes = viewerCalls
    .map((call, i) => {
      const v = values[i];
      return `${call.path} ${v == null ? "—" : `${v.toFixed(1)} ms`}`;
    })
    .join(", ");
  const setNote = `${viewerCalls.length} procedures (${source} call set) on long-run step 1, ${PROBE_CALLS} passes after ${PROBE_WARMUP} warm-ups, under the reviewers' load`;
  const time: Measurement = {
    id: "R4.time",
    value: slowest,
    samples: PROBE_CALLS,
    note: `slowest p95 of ${setNote}: ${pathTimes}${failures > 0 ? `; ${failures} calls failed (see R8)` : ""}`,
    ...(refused?.error !== undefined ? { error: refused.error } : {}),
  };
  if (largest === undefined) {
    return [
      time,
      {
        id: "R4.size",
        value: null,
        error: "no measured pass of the viewer call set fully succeeded",
      },
    ];
  }
  const sizes = viewerCalls
    .map(
      (c) =>
        `${c.path} ${((largest.byPath.get(c.path) ?? 0) / 1024).toFixed(1)} KB`,
    )
    .join(", ");
  const size: Measurement = {
    id: "R4.size",
    value: largest.bytes / 1024,
    samples: 1,
    note: `decoded JSON of the largest measured pass of ${setNote}: ${sizes}; wire bytes are the same (the api does not compress responses)`,
  };
  return [time, size];
}

/**
 * The storage proxy's server-side time of the one GET just answered: the
 * change in the route's histogram `sum`. Only this probe calls the route, one
 * request at a time, so the change is that request's own observation. The api
 * observes in `onResponse`, which can run after the client has the body, so
 * the count is awaited.
 */
async function observedSeconds(
  stack: Stack,
  before: { count: number; sum: number },
): Promise<number> {
  const deadline = performance.now() + OBSERVE_TIMEOUT_MS;
  for (;;) {
    const now = await readHistogram(stack.registries.api, HTTP_METRIC, {
      method: "GET",
      route: STORAGE_ROUTE,
    });
    if (now.count === before.count + 1) return now.sum - before.sum;
    if (now.count > before.count + 1) {
      throw new Error(
        "another request reached the storage proxy during R6; its server time cannot be told apart",
      );
    }
    if (performance.now() > deadline) {
      throw new Error("the api did not observe the storage GET");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * R6: the storage proxy's server time for a non-admin, minus the object
 * download. Each round GETs the probe key (owned by exactly one row) through
 * the proxy, reads that request's server time from the HTTP histogram, then
 * times `storage.get` of the same key directly; the two p95s are subtracted.
 */
async function measureStorageProxy(
  stack: Stack,
  seeded: Seeded,
  token: string,
  rec: Recorder,
): Promise<Measurement> {
  const key = seeded.uniqueKeyProbe;
  const url = `${stack.apiUrl}/api/v1/storage/${key}`;
  const serverMs: number[] = [];
  const storageMs: number[] = [];
  for (let i = 0; i < PROBE_WARMUP + PROBE_CALLS; i++) {
    rec.alive();
    const before = await readHistogram(stack.registries.api, HTTP_METRIC, {
      method: "GET",
      route: STORAGE_ROUTE,
    });
    let status = 0;
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      await res.arrayBuffer();
      status = res.status;
    } finally {
      rec.statuses.push({ status });
    }
    if (status !== 200) {
      throw new Error(`the storage proxy answered ${status} for the probe key`);
    }
    const seconds = await observedSeconds(stack, before);

    const started = performance.now();
    const bytes = await stack.storage.get(key);
    const direct = performance.now() - started;
    if (bytes.byteLength === 0) {
      throw new Error("the probe key's object is empty");
    }

    if (i >= PROBE_WARMUP) {
      serverMs.push(seconds * 1000);
      storageMs.push(direct);
    }
  }
  const { value, serverP95, storageP95 } = serverMinusStorage(
    serverMs,
    storageMs,
  );
  return {
    id: "R6",
    value,
    samples: PROBE_CALLS,
    note: `server time p95 ${serverP95.toFixed(2)} ms (each GET's own observation in ${HTTP_METRIC}) minus storage get p95 ${storageP95.toFixed(2)} ms (the same key read directly after each GET), ${PROBE_CALLS} GETs after ${PROBE_WARMUP} warm-ups as a reviewer, under the reviewers' load`,
  };
}
