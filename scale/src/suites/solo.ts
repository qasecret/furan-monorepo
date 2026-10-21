import {
  appRouter,
  findNext,
  type Context,
  type NextInput,
  type QueueAt,
} from "@furan/api/scale";
import { withUserScope, type DB } from "@furan/db";
import { Registry } from "@furan/telemetry";

import type { Measurement } from "../budgets.js";
import type { Seeded } from "../seed/index.js";
import type { Stack } from "../stack/api.js";
import { percentile } from "../stats.js";

/**
 * R1-solo and R2-solo (spec §5.3): the previous perf script's
 * (`apps/api/scripts/perf-review-loop.ts`) measurement, carried over
 * unchanged. One caller, no HTTP: `findNext` straight on the database, and
 * the procedures through `appRouter.createCaller` as a reviewer (`editor`),
 * each timed 50 times after 5 warm-ups, p95 by nearest rank. The cases are the
 * script's `timeAll` (the main project) and `timeResolved` (the worst-case
 * project, where every recent batch is resolved), on the owner connection,
 * as the script's default run.
 *
 * Each budget is the slowest p95 over its cases; its note lists every case.
 * The script's unbudgeted reference rows are noted beside the budget they
 * belong to.
 */

const WARMUP = 5;
const CALLS = 50;

interface Timed {
  label: string;
  p50: number;
  p95: number;
  max: number;
}

async function measure(
  label: string,
  fn: () => Promise<unknown>,
): Promise<Timed> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const ms: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return {
    label,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    max: ms[ms.length - 1]!,
  };
}

/** A tRPC caller as the seed's editor, on `db`. */
function callerFor(db: DB, editorId: string) {
  const ctx = {
    user: { id: editorId, role: "editor", via: "jwt" },
    db,
    telemetry: { metrics: new Registry() },
  } as unknown as Context;
  return appRouter.createCaller(ctx);
}

/** `findNext` on the plain handle, or in a user-scoped transaction (RLS). */
function directFor(
  db: DB,
  editorId: string,
  projectId: string,
  scoped: boolean,
) {
  return (input: Omit<NextInput, "projectId">) =>
    scoped
      ? withUserScope(
          db,
          { userId: editorId, role: "editor", projectId },
          (tx) => findNext(tx, { projectId, ...input }),
        )
      : findNext(db, { projectId, ...input });
}

/** What `timeAll` measures on the main project. */
interface MainTimings {
  findNext: Timed[];
  reviewNext: Timed[];
  runsListPending: Timed;
  buildsListNeedsReview: Timed;
  pendingCount: Timed;
  buildsListReference: Timed;
  runsListReference: Timed;
}

async function timeAll(
  db: DB,
  seeded: Seeded,
  scoped: boolean,
): Promise<MainTimings> {
  const { projectId } = seeded;
  const editorId = editorOf(seeded);
  const spots = seeded.soloSpots;
  const api = callerFor(db, editorId);
  const direct = directFor(db, editorId, projectId, scoped);

  const cases: [string, { at?: QueueAt }][] = [
    ["at mid-batch (review batch)", { at: spots.mid }],
    ["no at", {}],
    ["at the batch's last pending step", { at: spots.last }],
    [
      "at the only pending step of a batch (findNext: 5 statements)",
      { at: spots.exhausted },
    ],
  ];
  const findNextRows: Timed[] = [];
  for (const [name, input] of cases) {
    findNextRows.push(await measure(`findNext, ${name}`, () => direct(input)));
  }
  const reviewNextRows: Timed[] = [];
  for (const [name, input] of cases) {
    reviewNextRows.push(
      await measure(`review.next, ${name}`, () =>
        api.review.next({ projectId, ...input }),
      ),
    );
  }
  const runsListPending = await measure(
    `runs.list pending, order capture (review batch)`,
    () =>
      api.runs.list({
        projectId,
        buildId: seeded.newestBuildId,
        pending: true,
        order: "capture",
      }),
  );
  const buildsListNeedsReview = await measure(`builds.list needsReview`, () =>
    api.builds.list({ projectId, needsReview: true }),
  );
  const pendingCount = await measure(
    `builds.pendingCount (sidebar badge)`,
    () => api.builds.pendingCount({ projectId }),
  );
  const buildsListReference = await measure(`builds.list, no filter`, () =>
    api.builds.list({ projectId }),
  );
  const runsListReference = await measure(
    `runs.list capture, no pending filter`,
    () =>
      api.runs.list({
        projectId,
        buildId: seeded.newestBuildId,
        order: "capture",
      }),
  );
  return {
    findNext: findNextRows,
    reviewNext: reviewNextRows,
    runsListPending,
    buildsListNeedsReview,
    pendingCount,
    buildsListReference,
    runsListReference,
  };
}

/** What `timeResolved` measures on the worst-case project. */
interface WorstTimings {
  next: Timed[];
  buildsListNeedsReview: Timed;
  pendingCount: Timed;
  buildsListReference: Timed;
}

async function timeResolved(
  db: DB,
  seeded: Seeded,
  scoped: boolean,
): Promise<WorstTimings> {
  const projectId = seeded.resolvedProjectId;
  const editorId = editorOf(seeded);
  const api = callerFor(db, editorId);
  const direct = directFor(db, editorId, projectId, scoped);
  const cases: [string, { at?: QueueAt }][] = [
    ["no at", {}],
    [
      "at the newest pending batch's last pending step",
      { at: seeded.soloSpots.worstNewestKept },
    ],
  ];
  const next: Timed[] = [];
  for (const [name, input] of cases) {
    next.push(
      await measure(`worst case: findNext, ${name}`, () => direct(input)),
    );
  }
  for (const [name, input] of cases) {
    next.push(
      await measure(`worst case: review.next, ${name}`, () =>
        api.review.next({ projectId, ...input }),
      ),
    );
  }
  return {
    next,
    buildsListNeedsReview: await measure(
      `worst case: builds.list needsReview`,
      () => api.builds.list({ projectId, needsReview: true }),
    ),
    pendingCount: await measure(`worst case: builds.pendingCount`, () =>
      api.builds.pendingCount({ projectId }),
    ),
    buildsListReference: await measure(
      `worst case: builds.list, no filter`,
      () => api.builds.list({ projectId }),
    ),
  };
}

/** The script's one editor: the seed's first reviewer. */
function editorOf(seeded: Seeded): string {
  const editor = seeded.reviewers[0];
  if (editor === undefined) throw new Error("the seed has no reviewers");
  return editor.id;
}

const ms = (n: number): string => `${n.toFixed(1)} ms`;
const describeRow = (t: Timed): string =>
  `${t.label}: p50 ${ms(t.p50)}, p95 ${ms(t.p95)}, max ${ms(t.max)}`;

/** The slowest p95 over `rows`, every case in the note. */
function slowest(id: string, rows: Timed[], reference?: Timed): Measurement {
  const value = Math.max(...rows.map((r) => r.p95));
  return {
    id,
    value,
    samples: CALLS,
    note: [
      `max p95 over ${rows.length} case${rows.length === 1 ? "" : "s"}, ${CALLS} calls each after ${WARMUP} warm-ups, one caller, no HTTP`,
      ...rows.map(describeRow),
      ...(reference
        ? [`reference (unbudgeted) ${describeRow(reference)}`]
        : []),
    ].join("; "),
  };
}

/**
 * R1-solo.findNext, R1-solo.reviewNext and R1-solo.worst, and the four
 * R2-solo rows. Runs alone: the server suite calls it before its reviewers
 * start, while the review queue is as seeded.
 */
export async function runSolo(
  stack: Stack,
  seeded: Seeded,
): Promise<Measurement[]> {
  const scoped = false;
  const main = await timeAll(stack.db, seeded, scoped);
  const worst = await timeResolved(stack.db, seeded, scoped);
  return [
    slowest("R1-solo.findNext", main.findNext),
    slowest("R1-solo.reviewNext", main.reviewNext),
    slowest("R1-solo.worst", worst.next),
    slowest("R2-solo.pendingCount", [main.pendingCount]),
    slowest(
      "R2-solo.runsListPending",
      [main.runsListPending],
      main.runsListReference,
    ),
    slowest(
      "R2-solo.buildsListNeedsReview",
      [main.buildsListNeedsReview],
      main.buildsListReference,
    ),
    slowest(
      "R2-solo.worst",
      [worst.buildsListNeedsReview, worst.pendingCount],
      worst.buildsListReference,
    ),
  ];
}
