import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  builds,
  checkpointDecisions,
  eq,
  inArray,
  screenshots,
  sql,
  testRuns,
  type SQL,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../src/lib/keyset-cursor.js";
import { pendingBuildIds } from "../src/lib/review/pending.js";
import type { Context } from "../src/trpc/context.js";
import { buildsRouter } from "../src/trpc/v1/builds.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import {
  bodyStatements,
  capturing,
  type CapturedStatement,
} from "./capturing-db.js";
import { createTestApp, type TestApp } from "./helpers.js";
import { pendingCountsByBuild } from "./pending-oracle.js";
import {
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  syncRunCounters,
  type ReviewCheckpointSpec,
  type ReviewRunSpec,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * `builds.list` pages first, then aggregates (spec 2026-10-27 §4,
 * "`builds.list`"; budget R3), and answers exactly what it answered when it
 * aggregated every run of the project before paging.
 *
 * GOLDEN_ITEMS and GOLDEN_CALLS hold what the aggregate-first list returned
 * on the seeds below, captured from it at 2a68b5ad (before the rewrite).
 * Ids are random per seed, so results are compared structurally: every id
 * is replaced by its label (batches `L0`..., the project `P`, the editor),
 * a creation time by `t:<batch>` (exactly the column's text, which the list
 * returns as Postgres writes it), a test name `run-<tag>` by `run-*`, and
 * `updatedAt` (the insert time) by `*`.
 */

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

type ListInput = inferRouterInputs<AppRouter>["builds"]["list"];
type ListQuery = Omit<ListInput, "projectId">;
type ListPage = inferRouterOutputs<AppRouter>["builds"]["list"];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

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

/** A seeded project, with a label for every id and creation time. */
interface World {
  s: ReviewSeed;
  /** label → id */
  id: Record<string, string>;
  /** id (or creation time) → label */
  label: Map<string, string>;
  /** batch label → its `created_at` as the cursor writes it (µs, UTC) */
  cursorAt: Record<string, string>;
}

/** `value` with every id and time replaced by its label. */
function labelled(value: unknown, w: World): unknown {
  if (typeof value === "string") {
    return (
      w.label.get(value) ?? (/^run-[0-9a-f]{8}$/.test(value) ? "run-*" : value)
    );
  }
  if (Array.isArray(value)) return value.map((v) => labelled(v, w));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, labelled(v, w)]),
    );
  }
  return value;
}

/** The exact keys of a list item, in the order the procedure writes them. */
const ITEM_KEYS = [
  "id",
  "ciBuildId",
  "number",
  "branchName",
  "status",
  "name",
  "testName",
  "properties",
  "projectId",
  "userId",
  "isRunning",
  "environment",
  "createdAt",
  "updatedAt",
  "runCount",
  "runningCount",
  "unresolvedCount",
  "failedCount",
  "abortedCount",
  "passedCount",
  "emptyCount",
  "pendingCheckpoints",
  "aggregateStatus",
];

/** One page as GOLDEN_CALLS writes it: the batches, then the cursor's batch. */
interface PageSummary {
  ids: string[];
  next: string | null;
}
const pg = (next: string | null, ...ids: string[]): PageSummary => ({
  ids,
  next,
});

/**
 * A labelled item, as GOLDEN_ITEMS writes it: a run-less batch on `main` by
 * the editor, created at `t:<id>`, with `over` on top.
 */
const B = (id: string, over: Record<string, unknown>) => ({
  id,
  ciBuildId: null,
  number: null,
  branchName: "main",
  status: null,
  name: null,
  testName: "run-*",
  properties: {},
  projectId: "P",
  userId: "editor",
  isRunning: false,
  environment: "default",
  createdAt: `t:${id}`,
  updatedAt: "*",
  runCount: 0,
  runningCount: 0,
  unresolvedCount: 0,
  failedCount: 0,
  abortedCount: 0,
  passedCount: 0,
  emptyCount: 0,
  pendingCheckpoints: 0,
  aggregateStatus: "empty",
  ...over,
});

// ── Golden values ──────────────────────────────────────────────────────────
// Captured from the aggregate-first `builds.list` at 2a68b5ad.
const GOLDEN_ITEMS: Record<string, unknown> = {
  L16: B("L16", {
    runCount: 2,
    unresolvedCount: 1,
    passedCount: 1,
    pendingCheckpoints: 3,
    aggregateStatus: "unresolved",
  }),
  L15: B("L15", { runCount: 1, runningCount: 1, aggregateStatus: "running" }),
  L14: B("L14", {
    branchName: "feature",
    runCount: 1,
    passedCount: 1,
    aggregateStatus: "passed",
  }),
  L13: B("L13", {
    properties: { shard: "2", region: "us-east-1" },
    runCount: 2,
    passedCount: 2,
    pendingCheckpoints: 1,
    aggregateStatus: "passed",
  }),
  L12: B("L12", {
    number: 12,
    name: "Nightly 12",
    testName: null,
    runCount: 2,
    unresolvedCount: 1,
    passedCount: 1,
    pendingCheckpoints: 1,
    aggregateStatus: "unresolved",
  }),
  L11: B("L11", {
    branchName: "feature",
    runCount: 1,
    failedCount: 1,
    aggregateStatus: "failed",
  }),
  L10: B("L10", {
    runCount: 1,
    unresolvedCount: 1,
    pendingCheckpoints: 1,
    aggregateStatus: "unresolved",
  }),
  L9: B("L9", { runCount: 1, passedCount: 1, aggregateStatus: "passed" }),
  L8: B("L8", { branchName: "feature", runCount: 1, emptyCount: 1 }),
  L7: B("L7", { testName: null, properties: { region: "us-east-1" } }),
  L6: B("L6", {
    branchName: "feature",
    runCount: 2,
    abortedCount: 1,
    passedCount: 1,
    aggregateStatus: "aborted",
  }),
  L5: B("L5", {
    runCount: 3,
    runningCount: 1,
    failedCount: 1,
    passedCount: 1,
    pendingCheckpoints: 1,
    aggregateStatus: "running",
  }),
  L4: B("L4", {
    runCount: 2,
    runningCount: 1,
    passedCount: 1,
    aggregateStatus: "running",
  }),
  L3: B("L3", {
    branchName: "feature",
    runCount: 2,
    unresolvedCount: 1,
    failedCount: 1,
    pendingCheckpoints: 1,
    aggregateStatus: "unresolved",
  }),
  L2: B("L2", { runCount: 1, failedCount: 1, aggregateStatus: "failed" }),
  L1: B("L1", {
    branchName: "feature",
    properties: { region: "us-west-2" },
    runCount: 1,
    passedCount: 1,
    pendingCheckpoints: 1,
    aggregateStatus: "passed",
  }),
  L0: B("L0", {
    properties: { shard: "1", region: "us-east-1" },
    runCount: 1,
    passedCount: 1,
    aggregateStatus: "passed",
  }),
};

/** The main project's batches, newest first. */
const EVERY_BATCH = Array.from({ length: 17 }, (_, i) => `L${16 - i}`);
const GOLDEN_CALLS: Record<string, PageSummary[]> = {
  all: [pg(null, ...EVERY_BATCH)],
  "all, limit 5": [
    pg("L12", "L16", "L15", "L14", "L13", "L12"),
    pg("L7", "L11", "L10", "L9", "L8", "L7"),
    pg("L2", "L6", "L5", "L4", "L3", "L2"),
    pg(null, "L1", "L0"),
  ],
  "needsReview: false, noPending: false, anyFailed: false": [
    pg(null, ...EVERY_BATCH),
  ],
  needsReview: [
    pg("L12", "L16", "L13", "L12"),
    pg("L3", "L10", "L5", "L3"),
    pg(null, "L1"),
  ],
  noPending: [
    pg("L11", "L15", "L14", "L11"),
    pg("L7", "L9", "L8", "L7"),
    pg("L2", "L6", "L4", "L2"),
    pg(null, "L0"),
  ],
  anyFailed: [pg("L5", "L11", "L5"), pg(null, "L3", "L2")],
  "status running": [pg("L5", "L15", "L5"), pg(null, "L4")],
  "status unresolved": [pg("L12", "L16", "L12"), pg(null, "L10", "L3")],
  "status failed": [pg("L11", "L11"), pg(null, "L2")],
  "status aborted": [pg(null, "L6")],
  "status passed": [
    pg("L13", "L14", "L13"),
    pg("L1", "L9", "L1"),
    pg(null, "L0"),
  ],
  "status empty": [pg("L8", "L8"), pg(null, "L7")],
  "Passed chip (status passed, noPending)": [
    pg("L9", "L14", "L9"),
    pg(null, "L0"),
  ],
  "branch main": [
    pg("L12", "L16", "L15", "L13", "L12"),
    pg("L5", "L10", "L9", "L7", "L5"),
    pg(null, "L4", "L2", "L0"),
  ],
  "branch feature": [pg("L6", "L14", "L11", "L8", "L6"), pg(null, "L3", "L1")],
  "a branch no batch has": [pg(null)],
  "properties region": [pg("L7", "L13", "L7"), pg(null, "L0")],
  "properties region and shard": [pg(null, "L0")],
  "properties, needsReview": [pg(null, "L13")],
  "needsReview, branch main": [
    pg("L13", "L16", "L13"),
    pg("L10", "L12", "L10"),
    pg(null, "L5"),
  ],
  "needsReview, status unresolved": [
    pg("L12", "L16", "L12"),
    pg(null, "L10", "L3"),
  ],
  "needsReview, anyFailed": [pg(null, "L5", "L3")],
  "needsReview, status running": [pg(null, "L5")],
  "needsReview, noPending": [pg(null)],
  "anyFailed, status failed": [pg(null, "L11", "L2")],
  "anyFailed, status unresolved": [pg(null, "L3")],
  "noPending, branch feature": [pg("L11", "L14", "L11"), pg(null, "L8", "L6")],
  "noPending, status empty": [pg(null, "L8", "L7")],
  "status passed, noPending, branch main": [pg(null, "L9", "L0")],
  "from the middle (after L8)": [
    pg("L4", "L7", "L6", "L5", "L4"),
    pg(null, "L3", "L2", "L1", "L0"),
  ],
  "needsReview from the middle (after L12)": [
    pg(null, "L10", "L5", "L3", "L1"),
  ],
  "past the end (after the oldest)": [pg(null)],
  "needsReview past the end (after its oldest)": [pg(null)],
  "older than every batch": [pg(null)],
  "a malformed cursor starts from the top": [
    pg("L12", "L16", "L15", "L14", "L13", "L12"),
    pg("L7", "L11", "L10", "L9", "L8", "L7"),
    pg("L2", "L6", "L5", "L4", "L3", "L2"),
    pg(null, "L1", "L0"),
  ],
};

d("builds.list pages before it aggregates", () => {
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

  function list(w: World, query: ListQuery = {}): Promise<ListPage> {
    return makeClient(baseUrl, w.s.editor.jwt).builds.list.query({
      projectId: w.s.projectId,
      ...query,
    });
  }

  /** Every page of `query`, following `nextCursor` to the end. */
  async function walk(w: World, query: ListQuery): Promise<ListPage[]> {
    const pages: ListPage[] = [];
    let cursor = query.cursor;
    for (let i = 0; i < 50; i++) {
      const page = await list(w, {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push(page);
      if (!page.nextCursor) return pages;
      cursor = page.nextCursor;
    }
    throw new Error("walk: more than 50 pages");
  }

  async function pendingCount(w: World): Promise<number> {
    const r = await makeClient(
      baseUrl,
      w.s.editor.jwt,
    ).builds.pendingCount.query({ projectId: w.s.projectId });
    return r.total;
  }

  /**
   * The cursor's batch label. The cursor is checked first: it decodes to the
   * batch's id and its exact (µs) creation time, and encodes back to itself.
   */
  function cursorLabel(w: World, raw: string): string {
    const decoded = decodeKeysetCursor(raw);
    expect(decoded).not.toBeNull();
    expect(encodeKeysetCursor(decoded!)).toBe(raw);
    const at = w.label.get(decoded!.id);
    expect(at, "the cursor names a seeded batch").toBeDefined();
    expect(decoded!.createdAt).toBe(w.cursorAt[at!]);
    return at!;
  }

  /** A page's batches and cursor, labelled. */
  function summary(w: World, page: ListPage): PageSummary {
    return {
      ids: page.items.map((i) => w.label.get(i.id) ?? i.id),
      next: page.nextCursor ? cursorLabel(w, page.nextCursor) : null,
    };
  }

  /** An item, labelled, `updatedAt` checked to be a time and then masked. */
  function item(w: World, raw: ListPage["items"][number]): unknown {
    expect(Object.keys(raw)).toEqual(ITEM_KEYS);
    expect(Number.isNaN(Date.parse(String(raw.updatedAt)))).toBe(false);
    return labelled({ ...raw, updatedAt: "*" }, w);
  }

  /** Sets the builds' `created_at`, oldest first, 1 s apart. */
  async function orderBuilds(buildIds: string[]): Promise<void> {
    const base = Date.now() - 7_200_000;
    for (const [i, id] of buildIds.entries()) {
      await h.db
        .update(builds)
        .set({ createdAt: new Date(base + i * 1_000) })
        .where(eq(builds.id, id));
    }
  }

  interface BatchSpec {
    label: string;
    branch: string;
    /** `[]`: a batch with no runs (not allowed first: the seed needs a run). */
    runs: ReviewRunSpec[];
    properties?: Record<string, string>;
    name?: string;
    number?: number;
  }

  /** Builds a labelled world. `batches` go oldest first. */
  async function world(batches: BatchSpec[]): Promise<World> {
    const [first, ...rest] = batches;
    const s = await seedReviewRun(h, first!.runs[0]!, {
      branch: first!.branch,
    });
    seeds.push(s);
    const w: World = { s, id: {}, label: new Map(), cursorAt: {} };
    const name = (label: string, id: string) => {
      w.id[label] = id;
      w.label.set(id, label);
    };
    name("P", s.projectId);
    name("editor", s.editor.id);
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
            branchName: b.branch,
          })
          .returning({ id: builds.id });
        name(b.label, row!.id);
        continue;
      }
      const built = await addReviewBuild(h, s, {
        branch: b.branch,
        spec: b.runs[0]!,
      });
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
    for (const b of batches) {
      if (b.properties || b.name !== undefined || b.number !== undefined) {
        await h.db
          .update(builds)
          .set({
            ...(b.properties ? { properties: b.properties } : {}),
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.number !== undefined ? { number: b.number } : {}),
          })
          .where(eq(builds.id, w.id[b.label]!));
      }
    }
    await orderBuilds(batches.map((b) => w.id[b.label]!));
    const times = await h.db.execute<{ id: string; at: string; txt: string }>(
      sql`select id, created_at::text as txt,
                 to_char(created_at at time zone 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
          from builds where project_id = ${s.projectId}`,
    );
    for (const t of times) {
      const batch = w.label.get(t.id)!;
      w.cursorAt[batch] = t.at;
      // The item's `createdAt` (the column's text: the list reads it raw)
      // and the cursor's µs text.
      w.label.set(t.txt, `t:${batch}`);
      w.label.set(t.at, `t:${batch}`);
    }
    return w;
  }

  /**
   * A decision on each of `steps` (labels), written directly, then the runs'
   * counters (and rollup status) brought in line, as the app's decide core
   * does.
   */
  async function decide(
    w: World,
    steps: string[],
    opts: { reverted?: boolean; decision?: "approved" | "rejected" } = {},
  ): Promise<void> {
    const ids = steps.map((l) => w.id[l]!);
    const rows = await h.db
      .select({ id: screenshots.id, runId: screenshots.runId })
      .from(screenshots)
      .where(inArray(screenshots.id, ids));
    for (const row of rows) {
      await h.db.insert(checkpointDecisions).values({
        projectId: w.s.projectId,
        runId: row.runId,
        screenshotId: row.id,
        actionId: randomUUID(),
        decision: opts.decision ?? "approved",
        actorId: w.s.editor.id,
        source: "viewer",
        before: null,
        revertedAt: opts.reverted ? new Date() : null,
        revertedBy: opts.reverted ? w.s.editor.id : null,
      });
    }
    await syncRunCounters(
      h.db,
      rows.map((r) => r.runId),
    );
  }

  /** The step's final diff failure, as `markStepDiffFailed` writes it. */
  async function failDiff(w: World, step: string): Promise<void> {
    const [row] = await h.db
      .update(screenshots)
      .set({
        verdict: "unresolved",
        verdictAt: new Date(),
        diffFailedAt: new Date(),
        diffError: "timeout",
      })
      .where(eq(screenshots.id, w.id[step]!))
      .returning({ runId: screenshots.runId });
    await syncRunCounters(h.db, [row!.runId]);
  }

  const cp = (
    name: string,
    verdict: ReviewCheckpointSpec["verdict"],
  ): ReviewCheckpointSpec => ({ name, verdict });
  const run = (...checkpoints: ReviewCheckpointSpec[]): ReviewRunSpec => ({
    checkpoints,
  });

  /**
   * The main project, oldest batch first (pending steps in brackets; the
   * aggregate status after the arrow):
   * - L0 main {us-east-1, shard 1}: r0 a b passed → passed.
   * - L1 feature {us-west-2}: r0 [c new] → passed (a `new` run).
   * - L2 main: r0 d rejected → failed.
   * - L3 feature: r0 [e]; r1 f rejected → unresolved, one failed run.
   * - L4 main: r0 g, still running; r1 h passed → running.
   * - L5 main: r0 running, no steps; r1 i rejected; r2 [j new] → running,
   *   one failed run.
   * - L6 feature: r0 k, aborted; r1 l passed → aborted.
   * - L7 main {us-east-1}: no runs → empty.
   * - L8 feature: r0 empty (no steps) → empty.
   * - L9 main: r0 m (new) approved → passed.
   * - L10 main: r0 [n], its diff failed → unresolved.
   * - L11 feature: r0 o, overridden to failed → failed.
   * - L12 main, "Nightly 12" #12: r0 [p] (its approval undone); r1 q passed,
   *   r (new) approved, a second test name → unresolved, no single test name.
   * - L13 main {us-east-1, shard 2}: r0 s passed; r1 [t new] → passed.
   * - L14 feature: r0 u, overridden to passed → passed.
   * - L15 main: r0 v beside w, not diffed yet → running.
   * - L16 main: r0 [x] [y]; r1 [z new] → unresolved.
   * And a second project whose batches never show in the first's list.
   */
  async function mainWorld(): Promise<World> {
    const w = await world([
      {
        label: "L0",
        branch: "main",
        properties: { region: "us-east-1", shard: "1" },
        runs: [run(cp("a", "passed"), cp("b", "passed"))],
      },
      {
        label: "L1",
        branch: "feature",
        properties: { region: "us-west-2" },
        runs: [run(cp("c", "new"))],
      },
      { label: "L2", branch: "main", runs: [run(cp("d", "unresolved"))] },
      {
        label: "L3",
        branch: "feature",
        runs: [run(cp("e", "unresolved")), run(cp("f", "unresolved"))],
      },
      {
        label: "L4",
        branch: "main",
        runs: [
          { lifecycle: "running", checkpoints: [cp("g", "unresolved")] },
          run(cp("h", "passed")),
        ],
      },
      {
        label: "L5",
        branch: "main",
        runs: [
          { lifecycle: "running", checkpoints: [] },
          run(cp("i", "unresolved")),
          run(cp("j", "new")),
        ],
      },
      {
        label: "L6",
        branch: "feature",
        runs: [
          { lifecycle: "aborted", checkpoints: [cp("k", "unresolved")] },
          run(cp("l", "passed")),
        ],
      },
      {
        label: "L7",
        branch: "main",
        properties: { region: "us-east-1" },
        runs: [],
      },
      {
        label: "L8",
        branch: "feature",
        runs: [{ lifecycle: "empty", checkpoints: [] }],
      },
      { label: "L9", branch: "main", runs: [run(cp("m", "new"))] },
      { label: "L10", branch: "main", runs: [run(cp("n", "unresolved"))] },
      {
        label: "L11",
        branch: "feature",
        runs: [{ override: "failed", checkpoints: [cp("o", "unresolved")] }],
      },
      {
        label: "L12",
        branch: "main",
        name: "Nightly 12",
        number: 12,
        runs: [
          run(cp("p", "unresolved")),
          run(cp("q", "passed"), cp("r", "new")),
        ],
      },
      {
        label: "L13",
        branch: "main",
        properties: { region: "us-east-1", shard: "2" },
        runs: [run(cp("s", "passed")), run(cp("t", "new"))],
      },
      {
        label: "L14",
        branch: "feature",
        runs: [{ override: "passed", checkpoints: [cp("u", "unresolved")] }],
      },
      {
        label: "L15",
        branch: "main",
        runs: [run(cp("v", "unresolved"), cp("w", null))],
      },
      {
        label: "L16",
        branch: "main",
        runs: [
          run(cp("x", "unresolved"), cp("y", "unresolved")),
          run(cp("z", "new")),
        ],
      },
    ]);
    await decide(w, ["d", "f", "i"], { decision: "rejected" });
    await decide(w, ["m", "r"]);
    await decide(w, ["p"], { reverted: true });
    await failDiff(w, "n");
    await h.db
      .update(testRuns)
      .set({ name: "another-test" })
      .where(eq(testRuns.id, w.id["L12.r1"]!));

    // Another project: pending and failed batches of its own.
    const other = await seedReviewRun(h, {
      checkpoints: [cp("q1", "unresolved")],
    });
    seeds.push(other);
    await addReviewBuild(h, other, {
      spec: { lifecycle: "failed", checkpoints: [cp("q2", "unresolved")] },
    });
    return w;
  }

  let mainOnce: Promise<World> | undefined;
  const main = () => (mainOnce ??= mainWorld());

  /** The calls GOLDEN_CALLS holds, each walked to its last page. */
  function mainCalls(w: World): Record<string, ListQuery> {
    const cursorAt = (batch: string) =>
      encodeKeysetCursor({ createdAt: w.cursorAt[batch]!, id: w.id[batch]! });
    return {
      all: {},
      "all, limit 5": { limit: 5 },
      "needsReview: false, noPending: false, anyFailed: false": {
        needsReview: false,
        noPending: false,
        anyFailed: false,
      },
      needsReview: { needsReview: true, limit: 3 },
      noPending: { noPending: true, limit: 3 },
      anyFailed: { anyFailed: true, limit: 2 },
      "status running": { status: "running", limit: 2 },
      "status unresolved": { status: "unresolved", limit: 2 },
      "status failed": { status: "failed", limit: 1 },
      "status aborted": { status: "aborted", limit: 1 },
      "status passed": { status: "passed", limit: 2 },
      "status empty": { status: "empty", limit: 1 },
      "Passed chip (status passed, noPending)": {
        status: "passed",
        noPending: true,
        limit: 2,
      },
      "branch main": { branch: "main", limit: 4 },
      "branch feature": { branch: "feature", limit: 4 },
      "a branch no batch has": { branch: "no-such-branch" },
      "properties region": { properties: { region: "us-east-1" }, limit: 2 },
      "properties region and shard": {
        properties: { region: "us-east-1", shard: "1" },
      },
      "properties, needsReview": {
        properties: { region: "us-east-1" },
        needsReview: true,
      },
      "needsReview, branch main": {
        needsReview: true,
        branch: "main",
        limit: 2,
      },
      "needsReview, status unresolved": {
        needsReview: true,
        status: "unresolved",
        limit: 2,
      },
      "needsReview, anyFailed": { needsReview: true, anyFailed: true },
      "needsReview, status running": { needsReview: true, status: "running" },
      "needsReview, noPending": { needsReview: true, noPending: true },
      "anyFailed, status failed": { anyFailed: true, status: "failed" },
      "anyFailed, status unresolved": {
        anyFailed: true,
        status: "unresolved",
      },
      "noPending, branch feature": {
        noPending: true,
        branch: "feature",
        limit: 2,
      },
      "noPending, status empty": { noPending: true, status: "empty" },
      "status passed, noPending, branch main": {
        status: "passed",
        noPending: true,
        branch: "main",
      },
      "from the middle (after L8)": { cursor: cursorAt("L8"), limit: 4 },
      "needsReview from the middle (after L12)": {
        needsReview: true,
        cursor: cursorAt("L12"),
      },
      "past the end (after the oldest)": { cursor: cursorAt("L0") },
      "needsReview past the end (after its oldest)": {
        needsReview: true,
        cursor: cursorAt("L1"),
      },
      "older than every batch": {
        cursor: encodeKeysetCursor({
          createdAt: "2000-01-01T00:00:00.000000Z",
          id: randomUUID(),
        }),
      },
      "a malformed cursor starts from the top": {
        cursor: "not-a-cursor",
        limit: 5,
      },
    };
  }

  test("every call answers what the aggregate-first list answered (GOLDEN)", async () => {
    const w = await main();
    const items: Record<string, unknown> = {};
    const calls: Record<string, PageSummary[]> = {};
    for (const [name, query] of Object.entries(mainCalls(w))) {
      const pages = await walk(w, query);
      calls[name] = pages.map((p) => summary(w, p));
      for (const p of pages) {
        for (const raw of p.items) {
          const label = w.label.get(raw.id)!;
          const got = item(w, raw);
          // An item is the same whichever filter and page it shows on.
          if (label in items) expect(got, label).toEqual(items[label]);
          else items[label] = got;
        }
      }
    }
    // Every id was labelled: a golden never holds a raw id.
    expect(JSON.stringify({ items, calls })).not.toMatch(UUID);
    expect(items).toEqual(GOLDEN_ITEMS);
    expect(calls).toEqual(GOLDEN_CALLS);
  });

  /** Each build's `sum(pending_steps)` over its runs, from the rows. */
  async function storedSums(w: World): Promise<Map<string, number>> {
    const rows = await h.db.execute<{ build_id: string; pending: number }>(sql`
      select b.id as build_id, coalesce(sum(r.pending_steps), 0)::int as pending
      from builds b left join test_runs r on r.build_id = b.id
      where b.project_id = ${w.s.projectId}
      group by b.id`);
    return new Map(rows.map((r) => [r.build_id, Number(r.pending)]));
  }

  test("pendingCheckpoints is the sum of the build's runs' stored counters", async () => {
    const w = await main();
    const [all] = await walk(w, {});
    const sums = await storedSums(w);
    const byCondition = await pendingCountsByBuild(h.db, {
      projectId: w.s.projectId,
      buildIds: all!.items.map((i) => i.id),
    });
    expect(all!.items).toHaveLength(17);
    for (const i of all!.items) {
      const label = w.label.get(i.id);
      expect(i.pendingCheckpoints, label).toBe(sums.get(i.id));
      // The counters agree with the steps here (the app's writers keep them).
      expect(i.pendingCheckpoints, label).toBe(byCondition.get(i.id) ?? 0);
    }
    // Not all zero: L16 sums two runs.
    expect(
      Object.fromEntries(
        all!.items
          .filter((i) => i.pendingCheckpoints > 0)
          .map((i) => [w.label.get(i.id), i.pendingCheckpoints]),
      ),
    ).toEqual({ L1: 1, L3: 1, L5: 1, L10: 1, L12: 1, L13: 1, L16: 3 });
  });

  /** The batches the Batches badge counts (`pendingBuildIds`), labelled. */
  async function badgeSet(w: World): Promise<string[]> {
    const rows = await h.db.execute<{ build_id: string }>(
      sql`select build_id from (${pendingBuildIds(w.s.projectId)}) pending_builds`,
    );
    return rows.map((r) => w.label.get(r.build_id) ?? r.build_id).sort();
  }

  async function needsReviewSet(w: World): Promise<string[]> {
    const pages = await walk(w, { needsReview: true, limit: 2 });
    return pages
      .flatMap((p) => p.items.map((i) => w.label.get(i.id) ?? i.id))
      .sort();
  }

  test("needs review lists exactly the batches the badge counts", async () => {
    const w = await main();
    const listed = await needsReviewSet(w);
    expect(listed).toEqual(["L1", "L10", "L12", "L13", "L16", "L3", "L5"]);
    expect(listed).toEqual(await badgeSet(w));
    expect(await pendingCount(w)).toBe(listed.length);
  });

  /**
   * Writes runs' stored counters directly: the stale values a writer that
   * skipped `recomputeRunStatus` would leave. `fn` runs with them; the
   * counters are recomputed after, whatever happens.
   */
  async function withStoredPending(
    w: World,
    stale: Record<string, number>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const runIds = Object.keys(stale).map((r) => w.id[r]!);
    try {
      for (const [r, pending] of Object.entries(stale)) {
        await h.db
          .update(testRuns)
          .set({ pendingSteps: pending })
          .where(eq(testRuns.id, w.id[r]!));
      }
      await fn();
    } finally {
      await syncRunCounters(h.db, runIds);
    }
  }

  test("needsReview, noPending and pendingCheckpoints read the stored counters, as the badge does", async () => {
    const w = await world([
      { label: "S0", branch: "main", runs: [run(cp("s0", "unresolved"))] },
      {
        label: "S1",
        branch: "main",
        runs: [run(cp("s1a", "unresolved"), cp("s1b", "new"))],
      },
      { label: "S2", branch: "main", runs: [run(cp("s2", "passed"))] },
    ]);
    const pendingOf = async (query: ListQuery = {}) =>
      Object.fromEntries(
        (await list(w, query)).items.map((i) => [
          w.label.get(i.id),
          i.pendingCheckpoints,
        ]),
      );
    // S0's step is pending by its rows, but its run says 0; S1's run says 7
    // for its two pending steps; S2 has nothing pending, but its run says 3.
    await withStoredPending(
      w,
      { "S0.r0": 0, "S1.r0": 7, "S2.r0": 3 },
      async () => {
        expect(await pendingOf()).toEqual({ S0: 0, S1: 7, S2: 3 });
        expect(await pendingOf({ needsReview: true })).toEqual({
          S1: 7,
          S2: 3,
        });
        expect(await pendingOf({ noPending: true })).toEqual({ S0: 0 });
        expect(await needsReviewSet(w)).toEqual(await badgeSet(w));
        expect(await pendingCount(w)).toBe(2);
      },
    );
    // Recomputed: the counters follow the steps again.
    expect(await pendingOf()).toEqual({ S0: 1, S1: 2, S2: 0 });
    expect(await pendingOf({ needsReview: true })).toEqual({ S0: 1, S1: 2 });
    expect(await needsReviewSet(w)).toEqual(await badgeSet(w));
  });

  interface PlanNode {
    "Node Type": string;
    Strategy?: string;
    "Relation Name"?: string;
    "Actual Rows": number;
    "Actual Loops": number;
    Plans?: PlanNode[];
  }

  test("the aggregate reads only the page's builds' runs, in one statement", async () => {
    // Twelve batches of three runs each, a few with pending work.
    const w = await world(
      Array.from({ length: 12 }, (_, i) => ({
        label: `G${i}`,
        branch: "main",
        runs: [
          run(cp(`g${i}a`, i % 3 === 0 ? "unresolved" : "passed")),
          run(cp(`g${i}b`, "passed")),
          run(cp(`g${i}c`, i % 4 === 0 ? "new" : "passed")),
        ],
      })),
    );
    const runsOf = async (labels: string[]) => {
      const [row] = await h.db.execute<{ n: number }>(sql`
        select count(*)::int as n from test_runs
        where build_id in (${sql.join(
          labels.map((l) => sql`${w.id[l]!}::uuid`),
          sql`, `,
        )})`);
      return Number(row!.n);
    };
    const cases: Array<[string, ListQuery, string[]]> = [
      // The page asks for limit + 1 batches, to know there is a next page.
      ["unfiltered", { limit: 2 }, ["G11", "G10", "G9"]],
      ["needsReview", { limit: 2, needsReview: true }, ["G9", "G8", "G6"]],
      ["anyFailed", { limit: 2, anyFailed: true }, []],
      // G9 holds an unresolved run, so it is not passed.
      ["status passed", { limit: 2, status: "passed" }, ["G11", "G10", "G8"]],
    ];
    for (const [name, query, pageBatches] of cases) {
      const statements: CapturedStatement[] = [];
      const caller = buildsRouter.createCaller({
        user: { id: w.s.admin.id, role: "admin", via: "jwt" },
        db: capturing(h.db, statements),
      } as unknown as Context);
      await caller.list({ projectId: w.s.projectId, ...query });
      const body = bodyStatements(statements);
      // One statement for the page: its rows, aggregates and pending counts.
      expect(body, name).toHaveLength(1);
      const [q] = body;
      // A raw statement (not a builder's), so it can be explained as it is.
      expect(typeof q, name).toBe("object");

      const [explained] = await h.db.execute<{ "QUERY PLAN": unknown }>(
        sql`explain (analyze, format json) ${q as SQL}`,
      );
      const raw = explained!["QUERY PLAN"];
      const [{ Plan }] = (typeof raw === "string" ? JSON.parse(raw) : raw) as [
        { Plan: PlanNode },
      ];
      // The runs each aggregate over test_runs consumed, and how often it ran.
      let consumed = 0;
      let aggregateLoops = 0;
      const aggregates: string[] = [];
      const readsRuns = (n: PlanNode): boolean =>
        n["Relation Name"] === "test_runs" || (n.Plans ?? []).some(readsRuns);
      // Rows × loops is exact here only because every batch of this world
      // has the same number of runs: Postgres reports a node's "Actual Rows"
      // as the average per loop, rounded, so uneven batches would make the
      // product an approximation.
      const sumRuns = (n: PlanNode): number =>
        (n["Relation Name"] === "test_runs"
          ? n["Actual Rows"] * n["Actual Loops"]
          : 0) + (n.Plans ?? []).reduce((acc, c) => acc + sumRuns(c), 0);
      const visit = (n: PlanNode) => {
        if (n["Node Type"] === "Aggregate" && readsRuns(n)) {
          aggregates.push(n.Strategy ?? "?");
          consumed += sumRuns(n);
          aggregateLoops = Math.max(aggregateLoops, n["Actual Loops"]);
          return;
        }
        n.Plans?.forEach(visit);
      };
      visit(Plan);
      // A per-build aggregate (no GROUP BY over the project's runs), run once
      // per page batch, over exactly those batches' runs.
      expect(aggregates.length, name).toBeGreaterThan(0);
      expect(new Set(aggregates), name).toEqual(new Set(["Plain"]));
      expect(aggregateLoops, name).toBe(pageBatches.length);
      expect(consumed, name).toBe(
        pageBatches.length === 0 ? 0 : await runsOf(pageBatches),
      );
    }
  });
});
