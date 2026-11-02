import type { AddressInfo } from "node:net";

import { builds, eq, inArray, screenshots, sql, testRuns } from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../src/lib/keyset-cursor.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  cp,
  decideDirectly,
  failDiff,
  seedReviewRun,
  type ReviewCheckpointSpec,
  type ReviewRunSpec,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * `runs.list`, `builds.getById` and `runs.getCheckpointGroup` read the runs'
 * stored counters and step counts, and select a group in SQL (spec 2026-10-27
 * §4, budgets R2 and R5), and answer what they answered when they counted
 * steps, decisions and legality in JS.
 *
 * The GOLDEN_* values are what those procedures returned on the world below,
 * captured from them at 5c8f9f8d (before the change). Ids are random per
 * seed, so results are compared structurally: every id is replaced by its
 * label (batches `B0`..., runs `B1.r0`..., steps by name, the project `P`, the
 * editor), a test name `run-<tag>` by `run-*`, a diff signature by `sigA` /
 * `sigB`, and every time by `*` (the run's own time is checked through the
 * cursor, which must name the run and its exact creation time).
 *
 * One deliberate difference: `builds.getById.pendingCheckpoints` used to
 * leave out a pending step whose diff failed (it counted the approvable
 * steps); it now counts it, as `builds.list` and the badge do (spec §4,
 * "`builds.getById`").
 */

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

type ListQuery = Omit<
  inferRouterInputs<AppRouter>["runs"]["list"],
  "projectId"
>;
type ListPage = inferRouterOutputs<AppRouter>["runs"]["list"];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** A time as either API path writes it: ISO from JSON, or Postgres' text. */
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

function makeClient(baseUrl: string, jwt: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers: { authorization: `Bearer ${jwt}` },
      }),
    ],
  });
}

/** A seeded project, with a label for every id. */
interface World {
  s: ReviewSeed;
  /** label → id */
  id: Record<string, string>;
  /** id (or signature) → label */
  label: Map<string, string>;
}

/** `value` with every id, signature and time replaced by its label. */
function labelled(value: unknown, w: World): unknown {
  if (typeof value === "string") {
    const known = w.label.get(value);
    if (known !== undefined) return known;
    if (/^run-[0-9a-f]{8}$/.test(value)) return "run-*";
    if (TIME.test(value)) return "*";
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => labelled(v, w));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, labelled(v, w)]),
    );
  }
  return value;
}

/** One page as GOLDEN_LIST_CALLS writes it: the runs, then the cursor's run. */
interface PageSummary {
  ids: string[];
  next: string | null;
}
const pg = (next: string | null, ...ids: string[]): PageSummary => ({
  ids,
  next,
});

/**
 * A labelled `runs.list` item, as GOLDEN_LIST_ITEMS writes it: a run of B1 on
 * the seed's branch with one undecided `unresolved` step and nothing pending
 * (by its counter and by `pendingCount`), with `over` on top.
 */
const R = (id: string, over: Record<string, unknown>) => ({
  id,
  imageName: null,
  diffName: null,
  diffPercent: null,
  diffTollerancePercent: null,
  diffThresholdOverride: null,
  pixelMisMatchCount: null,
  status: "unresolved",
  statusOverride: null,
  abortedByDiff: false,
  buildId: "B1",
  projectId: "P",
  merge: false,
  name: "run-*",
  customTags: null,
  baselineName: null,
  comment: null,
  vlmDescription: null,
  branchName: "feature/review",
  parentBranchName: null,
  baselineBranchName: null,
  tempIgnoreAreas: null,
  environment: "default",
  baselineSource: null,
  resolutionSource: null,
  thumbnailUrl: null,
  checkpointCount: 1,
  pendingSteps: 0,
  failedSteps: 0,
  completedAt: null,
  primarySignature: null,
  createdAt: "*",
  updatedAt: "*",
  buildName: null,
  buildNumber: null,
  buildCiBuildId: null,
  buildBranchName: "feature/review",
  buildCreatedAt: "*",
  pendingCount: 0,
  stepCount: 1,
  ...over,
});

/** A labelled `builds.getById` result: a batch of the editor's, `over` on top. */
const G = (id: string, over: Record<string, unknown>) => ({
  id,
  ciBuildId: null,
  number: null,
  branchName: "feature/review",
  status: null,
  name: null,
  testName: "run-*",
  properties: {},
  projectId: "P",
  userId: "editor",
  isRunning: false,
  environment: "default",
  createdAt: "*",
  updatedAt: "*",
  runCount: 0,
  runningCount: 0,
  unresolvedCount: 0,
  failedCount: 0,
  abortedCount: 0,
  passedCount: 0,
  newCount: 0,
  emptyCount: 0,
  stepsTotal: 0,
  pendingCheckpoints: 0,
  runByName: "Editor",
  aggregateStatus: "empty",
  ...over,
});

/** A labelled member of a `runs.getCheckpointGroup` result. */
const M = (step: string, runId: string, viewport = "1280x720") => ({
  id: step,
  runId,
  testName: "run-*",
  name: step,
  viewport,
});
const NO_GROUP = {
  checkpoints: [],
  checkpointCount: 0,
  runCount: 0,
  capped: false,
};

// ── Golden values ──────────────────────────────────────────────────────────
// Captured from the procedures at 5c8f9f8d.
const GOLDEN_LIST_ITEMS: Record<string, unknown> = {
  "B1.r0": R("B1.r0", {
    checkpointCount: 3,
    pendingSteps: 2,
    pendingCount: 2,
    stepCount: 3,
  }),
  "B1.r1": R("B1.r1", { status: "passed" }),
  "B1.r2": R("B1.r2", { status: "failed" }),
  "B1.r3": R("B1.r3", { pendingSteps: 1, pendingCount: 1 }),
  "B1.r4": R("B1.r4", { status: "running" }),
  "B1.r5": R("B1.r5", { status: "aborted" }),
  "B1.r6": R("B1.r6", { status: "empty", checkpointCount: 0, stepCount: 0 }),
  "B1.r7": R("B1.r7", { status: "failed", statusOverride: "failed" }),
  "B1.r8": R("B1.r8", { status: "failed", checkpointCount: 2, stepCount: 2 }),
  "B1.r9": R("B1.r9", { pendingSteps: 1, failedSteps: 1, pendingCount: 1 }),
  "B1.r10": R("B1.r10", { status: "passed" }),
  "B1.r11": R("B1.r11", {
    checkpointCount: 3,
    pendingSteps: 3,
    pendingCount: 3,
    stepCount: 3,
  }),
  "B1.r12": R("B1.r12", { status: "new", pendingSteps: 1, pendingCount: 1 }),
  "B1.r11 @375x812": R("B1.r11", {
    checkpointCount: 3,
    pendingSteps: 3,
    pendingCount: 1,
    stepCount: 3,
  }),
  "B1.r0 @chromium": R("B1.r0", {
    checkpointCount: 3,
    pendingSteps: 2,
    pendingCount: 2,
    stepCount: 3,
  }),
  "B1.r3 @chromium": R("B1.r3", { pendingSteps: 1, pendingCount: 1 }),
  "B1.r9 @chromium": R("B1.r9", {
    pendingSteps: 1,
    failedSteps: 1,
    pendingCount: 1,
  }),
  "B1.r11 @chromium": R("B1.r11", {
    checkpointCount: 3,
    pendingSteps: 3,
    pendingCount: 3,
    stepCount: 3,
  }),
  "B1.r12 @chromium": R("B1.r12", {
    status: "new",
    pendingSteps: 1,
    pendingCount: 1,
  }),
  "B2.r0": R("B2.r0", {
    buildId: "B2",
    checkpointCount: 2,
    pendingSteps: 1,
    pendingCount: 1,
    stepCount: 2,
  }),
  "B0.r0": R("B0.r0", { buildId: "B0", pendingSteps: 1, pendingCount: 1 }),
};

const GOLDEN_LIST_CALLS: Record<string, PageSummary[]> = {
  "batch, capture order": [
    pg("B1.r4", "B1.r0", "B1.r1", "B1.r2", "B1.r3", "B1.r4"),
    pg("B1.r9", "B1.r5", "B1.r6", "B1.r7", "B1.r8", "B1.r9"),
    pg(null, "B1.r10", "B1.r11", "B1.r12"),
  ],
  "batch, capture order, pending": [
    pg("B1.r9", "B1.r0", "B1.r3", "B1.r9"),
    pg(null, "B1.r11", "B1.r12"),
  ],
  "batch, newest first, pending": [
    pg(null, "B1.r12", "B1.r11", "B1.r9", "B1.r3", "B1.r0"),
  ],
  "batch, pending at 375x812": [pg(null, "B1.r11")],
  "batch, at 375x812": [pg(null, "B1.r11")],
  "batch, pending, unresolved": [pg(null, "B1.r11", "B1.r9", "B1.r3", "B1.r0")],
  "batch, pending, chromium, capture order": [
    pg("B1.r11", "B1.r0", "B1.r3", "B1.r9", "B1.r11"),
    pg(null, "B1.r12"),
  ],
  project: [
    pg("B1.r8", "B2.r0", "B1.r12", "B1.r11", "B1.r10", "B1.r9", "B1.r8"),
    pg("B1.r2", "B1.r7", "B1.r6", "B1.r5", "B1.r4", "B1.r3", "B1.r2"),
    pg(null, "B1.r1", "B1.r0", "B0.r0"),
  ],
  "project, pending": [
    pg("B1.r9", "B2.r0", "B1.r12", "B1.r11", "B1.r9"),
    pg(null, "B1.r3", "B1.r0", "B0.r0"),
  ],
};

const GOLDEN_BUILDS: Record<string, unknown> = {
  B0: G("B0", {
    runCount: 1,
    unresolvedCount: 1,
    stepsTotal: 1,
    pendingCheckpoints: 1,
    aggregateStatus: "unresolved",
  }),
  B1: G("B1", {
    runCount: 13,
    runningCount: 1,
    unresolvedCount: 4,
    failedCount: 3,
    abortedCount: 1,
    passedCount: 3,
    newCount: 1,
    emptyCount: 1,
    stepsTotal: 17,
    // The approvable steps: l, pending but its diff failed, was left out.
    pendingCheckpoints: 7,
    aggregateStatus: "running",
  }),
  B2: G("B2", {
    runCount: 1,
    unresolvedCount: 1,
    stepsTotal: 2,
    pendingCheckpoints: 1,
    aggregateStatus: "unresolved",
  }),
  B3: G("B3", { testName: null }),
};

/** The group of each seed: its build's other pending members, capture order. */
const GOLDEN_GROUPS: Record<string, unknown> = {
  a: {
    checkpoints: [
      M("b", "B1.r0"),
      M("f", "B1.r3"),
      M("o", "B1.r11", "375x812"),
      M("p", "B1.r11"),
    ],
    checkpointCount: 4,
    runCount: 3,
    capped: false,
  },
  b: {
    checkpoints: [
      M("a", "B1.r0"),
      M("f", "B1.r3"),
      M("o", "B1.r11", "375x812"),
      M("p", "B1.r11"),
    ],
    checkpointCount: 4,
    runCount: 3,
    capped: false,
  },
  o: {
    checkpoints: [
      M("a", "B1.r0"),
      M("b", "B1.r0"),
      M("f", "B1.r3"),
      M("p", "B1.r11"),
    ],
    checkpointCount: 4,
    runCount: 3,
    capped: false,
  },
  d: {
    checkpoints: [
      M("a", "B1.r0"),
      M("b", "B1.r0"),
      M("f", "B1.r3"),
      M("o", "B1.r11", "375x812"),
      M("p", "B1.r11"),
    ],
    checkpointCount: 5,
    runCount: 3,
    capped: false,
  },
  c: {
    checkpoints: [
      M("a", "B1.r0"),
      M("b", "B1.r0"),
      M("f", "B1.r3"),
      M("o", "B1.r11", "375x812"),
      M("p", "B1.r11"),
    ],
    checkpointCount: 5,
    runCount: 3,
    capped: false,
  },
  l: {
    checkpoints: [
      M("a", "B1.r0"),
      M("b", "B1.r0"),
      M("f", "B1.r3"),
      M("o", "B1.r11", "375x812"),
      M("p", "B1.r11"),
    ],
    checkpointCount: 5,
    runCount: 3,
    capped: false,
  },
  n: NO_GROUP,
  q: NO_GROUP,
  x: NO_GROUP,
  g0: NO_GROUP,
};

d("run list, batch detail and checkpoint group answer as before", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  const client = (w: World) => makeClient(baseUrl, w.s.editor.jwt);

  function list(w: World, query: ListQuery): Promise<ListPage> {
    return client(w).runs.list.query({ projectId: w.s.projectId, ...query });
  }

  /** Every page of `query`, following `nextCursor` to the end. */
  async function walk(w: World, query: ListQuery): Promise<ListPage[]> {
    const pages: ListPage[] = [];
    let cursor = query.cursor;
    for (let i = 0; i < 20; i++) {
      const page = await list(w, {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push(page);
      if (!page.nextCursor) return pages;
      cursor = page.nextCursor;
    }
    throw new Error("walk: more than 20 pages");
  }

  /**
   * The cursor's run label. The cursor is checked first: it decodes to the
   * run's id and its exact (µs) creation time, and encodes back to itself.
   */
  async function cursorLabel(w: World, raw: string): Promise<string> {
    const decoded = decodeKeysetCursor(raw);
    expect(decoded).not.toBeNull();
    expect(encodeKeysetCursor(decoded!)).toBe(raw);
    const at = w.label.get(decoded!.id);
    expect(at, "the cursor names a seeded run").toBeDefined();
    const [row] = await h.db.execute<{ at: string }>(sql`
      select to_char(created_at at time zone 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
      from test_runs where id = ${decoded!.id}`);
    expect(decoded!.createdAt).toBe(row!.at);
    return at!;
  }

  async function summary(w: World, page: ListPage): Promise<PageSummary> {
    return {
      ids: page.items.map((i) => w.label.get(i.id) ?? i.id),
      next: page.nextCursor ? await cursorLabel(w, page.nextCursor) : null,
    };
  }

  interface BatchSpec {
    label: string;
    /** `[]`: a batch with no runs (not allowed first: the seed needs a run). */
    runs: ReviewRunSpec[];
  }

  /** Builds a labelled world. `batches` go oldest first. */
  async function world(batches: BatchSpec[]): Promise<World> {
    const [first, ...rest] = batches;
    const s = await seedReviewRun(h, first!.runs[0]!);
    seeds.push(s);
    const w: World = { s, id: {}, label: new Map() };
    const name = (label: string, id: string) => {
      w.id[label] = id;
      w.label.set(id, label);
    };
    name("P", s.projectId);
    name("editor", s.editor.id);
    name("Editor", s.editor.name);
    const runOf = (
      batch: string,
      i: number,
      run: { runId: string; shotsInOrder: Array<{ id: string; name: string }> },
    ) => {
      name(`${batch}.r${i}`, run.runId);
      for (const shot of run.shotsInOrder) name(shot.name, shot.id);
    };
    name(first!.label, s.buildId);
    runOf(first!.label, 0, s);
    for (const [i, spec] of first!.runs.slice(1).entries()) {
      runOf(first!.label, i + 1, await addReviewRun(h, s, spec));
    }
    for (const b of rest) {
      if (b.runs.length === 0) {
        const [row] = await h.db
          .insert(builds)
          .values({
            projectId: s.projectId,
            userId: s.editor.id,
            branchName: s.branch,
          })
          .returning({ id: builds.id });
        name(b.label, row!.id);
        continue;
      }
      const built = await addReviewBuild(h, s, { spec: b.runs[0]! });
      name(b.label, built.buildId);
      runOf(b.label, 0, built);
      for (const [i, spec] of b.runs.slice(1).entries()) {
        runOf(
          b.label,
          i + 1,
          await addReviewRun(h, s, spec, { buildId: built.buildId }),
        );
      }
    }
    return w;
  }

  /** Gives `steps` (labels) the diff signature labelled `sig`. */
  async function sign(w: World, sig: string, steps: string[]): Promise<void> {
    const value = `${sig}-${w.s.tag}`;
    w.label.set(value, sig);
    await h.db
      .update(screenshots)
      .set({ diffSignature: value })
      .where(
        inArray(
          screenshots.id,
          steps.map((l) => w.id[l]!),
        ),
      );
  }

  const run = (...checkpoints: ReviewCheckpointSpec[]): ReviewRunSpec => ({
    checkpoints,
  });

  /**
   * The project, oldest batch first (pending steps in brackets; signature
   * sigA unless noted):
   * - B0: r0 [g0].
   * - B1, the batch under review, in capture order:
   *   r0 [a new] [b] c passed; r1 d approved; r2 e rejected; r3 [f] (its
   *   approval undone); r4 g, running; r5 h, aborted; r6 empty, no steps;
   *   r7 i, overridden to failed; r8 j beside k, not diffed yet; r9 [l], its
   *   diff failed; r10 m passed; r11 [n sigB] [o new, 375x812] [p];
   *   r12 [q new, no signature].
   * - B2: r0 [x] y passed.
   * - B3: no runs.
   */
  async function mainWorld(): Promise<World> {
    const w = await world([
      { label: "B0", runs: [run(cp("g0", "unresolved"))] },
      {
        label: "B1",
        runs: [
          run(cp("a", "new"), cp("b", "unresolved"), cp("c", "passed")),
          run(cp("d", "unresolved")),
          run(cp("e", "unresolved")),
          run(cp("f", "unresolved")),
          { lifecycle: "running", checkpoints: [cp("g", "unresolved")] },
          { lifecycle: "aborted", checkpoints: [cp("h", "unresolved")] },
          { lifecycle: "empty", checkpoints: [] },
          { override: "failed", checkpoints: [cp("i", "unresolved")] },
          {
            lifecycle: "failed",
            checkpoints: [cp("j", "unresolved"), cp("k", null)],
          },
          run(cp("l", "unresolved")),
          run(cp("m", "passed")),
          run(
            cp("n", "unresolved"),
            cp("o", "new", { viewport: "375x812" }),
            cp("p", "unresolved"),
          ),
          run(cp("q", "new")),
        ],
      },
      { label: "B2", runs: [run(cp("x", "unresolved"), cp("y", "passed"))] },
      { label: "B3", runs: [] },
    ]);
    await sign(w, "sigA", ["g0", ..."abcdefghijklmop".split(""), "x", "y"]);
    await sign(w, "sigB", ["n"]);
    await decideDirectly(h, w.s, [w.id.d!]);
    await decideDirectly(h, w.s, [w.id.e!], { decision: "rejected" });
    await decideDirectly(h, w.s, [w.id.f!], { reverted: true });
    await failDiff(h, w.id.l!);
    return w;
  }

  let mainOnce: Promise<World> | undefined;
  const main = () => (mainOnce ??= mainWorld());

  function listCalls(w: World): Record<string, ListQuery> {
    const b1 = w.id.B1!;
    return {
      "batch, capture order": { buildId: b1, order: "capture", limit: 5 },
      "batch, capture order, pending": {
        buildId: b1,
        order: "capture",
        pending: true,
        limit: 3,
      },
      "batch, newest first, pending": { buildId: b1, pending: true },
      "batch, pending at 375x812": {
        buildId: b1,
        pending: true,
        viewport: "375x812",
      },
      "batch, at 375x812": { buildId: b1, viewport: "375x812" },
      "batch, pending, unresolved": {
        buildId: b1,
        pending: true,
        status: ["unresolved"],
      },
      "batch, pending, chromium, capture order": {
        buildId: b1,
        pending: true,
        browser: "chromium",
        order: "capture",
        limit: 4,
      },
      project: { limit: 6 },
      "project, pending": { pending: true, limit: 4 },
    };
  }

  test("runs.list answers every call as before (GOLDEN)", async () => {
    const w = await main();
    const items: Record<string, unknown> = {};
    const calls: Record<string, PageSummary[]> = {};
    for (const [name, query] of Object.entries(listCalls(w))) {
      const pages = await walk(w, query);
      calls[name] = [];
      for (const p of pages) {
        calls[name].push(await summary(w, p));
        for (const raw of p.items) {
          const label = `${w.label.get(raw.id)!}${
            query.viewport || query.browser
              ? ` @${query.viewport ?? query.browser}`
              : ""
          }`;
          const got = labelled(raw, w);
          // An item is the same whichever page it shows on (its counts
          // depend on the facets, so a faceted call has its own entry).
          if (label in items) expect(got, label).toEqual(items[label]);
          else items[label] = got;
        }
      }
    }
    expect(JSON.stringify({ items, calls })).not.toMatch(UUID);
    expect(items).toEqual(GOLDEN_LIST_ITEMS);
    expect(calls).toEqual(GOLDEN_LIST_CALLS);
  });

  test("builds.getById answers as before (GOLDEN), its pending count now the list's", async () => {
    const w = await main();
    const got: Record<string, unknown> = {};
    for (const b of ["B0", "B1", "B2", "B3"]) {
      got[b] = labelled(
        await client(w).builds.getById.query({ buildId: w.id[b]! }),
        w,
      );
    }
    expect(JSON.stringify(got)).not.toMatch(UUID);
    // The old pendingCheckpoints counted what approve-pending acts on: it is
    // the new, additive approvableCheckpoints.
    const expected = Object.fromEntries(
      Object.entries(GOLDEN_BUILDS).map(([b, golden]) => {
        const g = golden as { pendingCheckpoints: number };
        return [b, { ...g, approvableCheckpoints: g.pendingCheckpoints }];
      }),
    );
    expect(got).toEqual({
      ...expected,
      // The one intended change: l, pending with its diff failed, now counts,
      // as it does in builds.list (spec 2026-10-27 §4, "`builds.getById`").
      B1: { ...expected.B1, pendingCheckpoints: 8 },
    });
    const listed = await client(w).builds.list.query({
      projectId: w.s.projectId,
    });
    expect(
      Object.fromEntries(
        listed.items.map((i) => [w.label.get(i.id), i.pendingCheckpoints]),
      ),
    ).toEqual({ B0: 1, B1: 8, B2: 1, B3: 0 });
  });

  test("runs.getCheckpointGroup answers every seed as before (GOLDEN)", async () => {
    const w = await main();
    const got: Record<string, unknown> = {};
    // Pending members (a, b, f, o, p, x, g0), a decided one (d), a passed one
    // (c), a diff-failed one (l), the only one of its signature (n), and one
    // with no signature (q).
    for (const seed of ["a", "b", "o", "d", "c", "l", "n", "q", "x", "g0"]) {
      const [row] = await h.db
        .select({ runId: screenshots.runId })
        .from(screenshots)
        .where(eq(screenshots.id, w.id[seed]!));
      got[seed] = labelled(
        await client(w).runs.getCheckpointGroup.query({
          runId: row!.runId,
          checkpointId: w.id[seed]!,
        }),
        w,
      );
    }
    expect(JSON.stringify(got)).not.toMatch(UUID);
    expect(got).toEqual(GOLDEN_GROUPS);
  });

  test("the world's stored counters agree with its steps", async () => {
    // Every golden above rests on counters the app's writers would keep.
    const w = await main();
    const rows = await h.db
      .select({
        id: testRuns.id,
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
        checkpointCount: testRuns.checkpointCount,
        // Aliased: a one-table select prints its own columns bare.
        steps: sql<number>`(select count(*)::int from screenshots s where s.run_id = test_runs.id)`,
      })
      .from(testRuns)
      .where(eq(testRuns.projectId, w.s.projectId));
    const byLabel = Object.fromEntries(
      rows.map((r) => [
        w.label.get(r.id),
        [r.pendingSteps, r.failedSteps, r.checkpointCount, r.steps],
      ]),
    );
    expect(byLabel).toEqual({
      "B0.r0": [1, 0, 1, 1],
      "B1.r0": [2, 0, 3, 3],
      "B1.r1": [0, 0, 1, 1],
      "B1.r2": [0, 0, 1, 1],
      "B1.r3": [1, 0, 1, 1],
      "B1.r4": [0, 0, 1, 1],
      "B1.r5": [0, 0, 1, 1],
      "B1.r6": [0, 0, 0, 0],
      "B1.r7": [0, 0, 1, 1],
      "B1.r8": [0, 0, 2, 2],
      "B1.r9": [1, 1, 1, 1],
      "B1.r10": [0, 0, 1, 1],
      "B1.r11": [3, 0, 3, 3],
      "B1.r12": [1, 0, 1, 1],
      "B2.r0": [1, 0, 2, 2],
    });
  });
});
