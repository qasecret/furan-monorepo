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
  withUserScope,
  type DB,
  type SQL,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { StepFacets } from "../src/lib/review/pending.js";
import {
  findNext,
  type NextInput,
  type NextResult,
  type QueueAt,
} from "../src/lib/review/queue.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";
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
 * The review queue (`findNext`, behind `review.next`) and the Batches badge
 * (`builds.pendingCount`) read the runs' stored pending counters (spec
 * 2026-10-27 §4, "`review.next` and `builds.pendingCount`"; budgets R1, R2)
 * and answer exactly what they answered when they re-derived "pending" from
 * every step of the project.
 *
 * GOLDEN holds what the condition-based reads returned on the seeds below,
 * captured from them at e56011bf, before they moved to the counters, so this
 * test cannot pass just because both sides now read the same columns. Ids are
 * random per seed, so results are compared structurally: every id is replaced
 * by its label (batches `B0`..., runs `B0.r1`..., steps by name), and a
 * batch's fallback name `run-<tag>` by `run-*`.
 */

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

const MOBILE = "375x812";
const DESKTOP = "1280x720";
const mobile: StepFacets = { viewport: MOBILE };
const firefox: StepFacets = { browser: "firefox" };

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

/** A seeded project, with a label for every batch, run and step id. */
interface World {
  s: ReviewSeed;
  /** label → id */
  id: Record<string, string>;
  /** id → label */
  label: Map<string, string>;
}

/** `value` with every id replaced by its label, and `run-<tag>` by `run-*`. */
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

/** A labelled target, as GOLDEN writes it. */
const T = (buildId: string, runId: string, checkpointId: string) => ({
  buildId,
  runId,
  checkpointId,
});

/** A labelled next batch, as GOLDEN writes it. */
const NB = (
  buildId: string,
  name: string,
  branch: string,
  pending: number,
  number: number | null = null,
) => ({ buildId, name, number, branch, pending });

/** `remaining`, as GOLDEN writes it. */
const R = (
  run: number,
  batch: number,
  batchUnfiltered: number,
  projectBatches: number,
) => ({ run, batch, batchUnfiltered, projectBatches });

// ── Golden values ──────────────────────────────────────────────────────────
// Captured from the condition-based `findNext` and `builds.pendingCount` at
// e56011bf (before they read the counters).
const GOLDEN: Record<string, unknown> = {
  "main: pendingCount": 5,
  "main: no at": {
    target: T("B6", "B6.r0", "p"),
    scope: "batch",
    remaining: R(0, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: no at, prev": {
    target: T("B6", "B6.r0", "p"),
    scope: "batch",
    remaining: R(0, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: no at, empty facets": {
    target: T("B6", "B6.r0", "p"),
    scope: "batch",
    remaining: R(0, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: no at, mobile": {
    target: T("B6", "B6.r0", "q"),
    scope: "batch",
    remaining: R(0, 1, 3, 3),
    nextBatch: NB("B3", "run-*", "feature", 1),
  },
  "main: no at, firefox": {
    target: T("B6", "B6.r1", "r"),
    scope: "batch",
    remaining: R(0, 1, 3, 2),
    nextBatch: NB("B0", "run-*", "main", 1),
  },
  "main: no at, a viewport no step has": {
    target: null,
    scope: "none",
    remaining: R(0, 0, 0, 0),
    nextBatch: null,
  },
  "main: no at, newest excluded": {
    target: T("B4", "B4.r0", "m"),
    scope: "batch",
    remaining: R(0, 1, 1, 5),
    nextBatch: NB("B3", "run-*", "feature", 1),
  },
  "main: no at, every pending batch excluded": {
    target: null,
    scope: "none",
    remaining: R(0, 0, 0, 5),
    nextBatch: null,
  },
  "main: at B0": {
    target: T("B0", "B0.r0", "a"),
    scope: "batch",
    remaining: R(0, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at B0, prev": {
    target: T("B0", "B0.r1", "d"),
    scope: "batch",
    remaining: R(0, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at B0.r0": {
    target: T("B0", "B0.r0", "a"),
    scope: "run",
    remaining: R(2, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at B0.r1": {
    target: T("B0", "B0.r1", "d"),
    scope: "run",
    remaining: R(1, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at a": {
    target: T("B0", "B0.r0", "c"),
    scope: "run",
    remaining: R(1, 2, 2, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at b (passed)": {
    target: T("B0", "B0.r0", "c"),
    scope: "run",
    remaining: R(2, 3, 3, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at d, prev": {
    target: T("B0", "B0.r0", "c"),
    scope: "batch",
    remaining: R(0, 2, 2, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at a, firefox": {
    target: T("B0", "B0.r1", "d"),
    scope: "batch",
    remaining: R(0, 1, 2, 2),
    nextBatch: NB("B6", "Nightly 6", "feature", 1, 6),
  },
  "main: at a, mobile": {
    target: T("B0", "B0.r0", "c"),
    scope: "run",
    remaining: R(1, 1, 2, 3),
    nextBatch: NB("B6", "Nightly 6", "feature", 1, 6),
  },
  "main: at c, mobile": {
    target: T("B6", "B6.r0", "q"),
    scope: "nextBatch",
    remaining: R(0, 0, 2, 2),
    nextBatch: NB("B6", "Nightly 6", "feature", 1, 6),
  },
  "main: at f (rejected)": {
    target: T("B1", "B1.r1", "g"),
    scope: "batch",
    remaining: R(0, 1, 1, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at g (only pending of B1)": {
    target: T("B4", "B4.r0", "m"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 4),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at B2 (nothing pending)": {
    target: T("B6", "B6.r0", "p"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 5),
    nextBatch: NB("B6", "Nightly 6", "feature", 3, 6),
  },
  "main: at B2.r1": {
    target: T("B6", "B6.r0", "p"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 5),
    nextBatch: NB("B6", "Nightly 6", "feature", 3, 6),
  },
  "main: at l (only pending of B3)": {
    target: T("B6", "B6.r0", "p"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 4),
    nextBatch: NB("B6", "Nightly 6", "feature", 3, 6),
  },
  "main: at l, mobile": {
    target: T("B6", "B6.r0", "q"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 2),
    nextBatch: NB("B6", "Nightly 6", "feature", 1, 6),
  },
  "main: at m (diff failed, only pending of B4)": {
    target: T("B1", "B1.r1", "g"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 4),
    nextBatch: NB("B1", "#11", "main", 1, 11),
  },
  "main: at m, B1 excluded": {
    target: T("B0", "B0.r0", "a"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 4),
    nextBatch: NB("B0", "run-*", "main", 3),
  },
  "main: at B5": {
    target: T("B6", "B6.r0", "p"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 5),
    nextBatch: NB("B6", "Nightly 6", "feature", 3, 6),
  },
  "main: at p": {
    target: T("B6", "B6.r0", "q"),
    scope: "run",
    remaining: R(1, 2, 2, 5),
    nextBatch: NB("B3", "run-*", "feature", 1),
  },
  "main: at r, mobile": {
    target: T("B6", "B6.r0", "q"),
    scope: "batch",
    remaining: R(0, 1, 2, 3),
    nextBatch: NB("B3", "run-*", "feature", 1),
  },
  "main: at r, prev": {
    target: T("B6", "B6.r0", "q"),
    scope: "batch",
    remaining: R(0, 2, 2, 5),
    nextBatch: NB("B3", "run-*", "feature", 1),
  },
  "main: at t, prev": {
    target: T("B4", "B4.r0", "m"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 5),
    nextBatch: NB("B4", "run-*", "main", 1),
  },
  "main: at B7, firefox": {
    target: T("B0", "B0.r1", "d"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 2),
    nextBatch: NB("B0", "run-*", "main", 1),
  },
  "worst: pendingCount": 2,
  "worst: no at": {
    target: T("W1", "W1.r0", "w1x"),
    scope: "batch",
    remaining: R(0, 2, 2, 2),
    nextBatch: NB("W0", "run-*", "main", 2),
  },
  "worst: no at, mobile": {
    target: T("W1", "W1.r0", "w1y"),
    scope: "batch",
    remaining: R(0, 1, 2, 2),
    nextBatch: NB("W0", "run-*", "main", 1),
  },
  "worst: no at, W1 excluded": {
    target: T("W0", "W0.r0", "w0x"),
    scope: "batch",
    remaining: R(0, 2, 2, 2),
    nextBatch: null,
  },
  "worst: at W13": {
    target: T("W1", "W1.r0", "w1x"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 2),
    nextBatch: NB("W1", "run-*", "feature", 2),
  },
  "worst: at w12x": {
    target: T("W0", "W0.r0", "w0x"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 2),
    nextBatch: NB("W0", "run-*", "main", 2),
  },
  "worst: at w13y, mobile": {
    target: T("W1", "W1.r0", "w1y"),
    scope: "nextBatch",
    remaining: R(0, 0, 0, 2),
    nextBatch: NB("W1", "run-*", "feature", 1),
  },
  "worst: at w1y, mobile": {
    target: T("W0", "W0.r0", "w0y"),
    scope: "nextBatch",
    remaining: R(0, 0, 1, 1),
    nextBatch: NB("W0", "run-*", "main", 1),
  },
  "worst: at w0x, prev": {
    target: T("W0", "W0.r0", "w0y"),
    scope: "run",
    remaining: R(1, 1, 1, 2),
    nextBatch: NB("W1", "run-*", "feature", 2),
  },
  "worst: at w1x": {
    target: T("W1", "W1.r0", "w1y"),
    scope: "run",
    remaining: R(1, 1, 1, 2),
    nextBatch: NB("W0", "run-*", "main", 2),
  },
};

d("review queue and pending count on the stored counters", () => {
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

  /** `findNext` as the seed's editor runs it: user-scoped, on the app's pool. */
  function next(
    s: ReviewSeed,
    input: Omit<NextInput, "projectId"> = {},
  ): Promise<NextResult> {
    return withUserScope(
      h.app.db,
      { userId: s.editor.id, role: "editor", projectId: s.projectId },
      (tx) => findNext(tx, { projectId: s.projectId, ...input }),
    );
  }

  async function pendingCount(s: ReviewSeed): Promise<number> {
    const r = await makeClient(baseUrl, s.editor.jwt).builds.pendingCount.query(
      { projectId: s.projectId },
    );
    return r.total;
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

  /**
   * Builds a labelled world. `batches` go oldest first; each is a branch and
   * its runs. The first batch is the seed's own.
   */
  async function world(
    batches: Array<{ label: string; branch: string; runs: ReviewRunSpec[] }>,
  ): Promise<World> {
    const [first, ...rest] = batches;
    const s = await seedReviewRun(h, first!.runs[0]!, {
      branch: first!.branch,
    });
    seeds.push(s);
    const w: World = { s, id: {}, label: new Map() };
    const name = (label: string, id: string) => {
      w.id[label] = id;
      w.label.set(id, label);
    };
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
    await orderBuilds(batches.map((b) => w.id[b.label]!));
    return w;
  }

  /**
   * A decision on each of `steps` (labels), written directly, then the runs'
   * counters brought in line (the app's decide core recomputes them).
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
    env: { viewport?: string; browser?: string } = {},
  ): ReviewCheckpointSpec => ({ name, verdict, ...env });
  const run = (...checkpoints: ReviewCheckpointSpec[]): ReviewRunSpec => ({
    checkpoints,
  });

  /**
   * The main project, oldest batch first (pending steps in brackets):
   * - B0 main: r0 [a] b passed [c mobile]; r1 [d firefox] e approved.
   * - B1 main, "#11" (its runs' test names differ): r0 f rejected;
   *   r1 [g] (its approval undone); r2 h, overridden.
   * - B2 feature: r0 i, still running; r1 j beside k, not diffed yet.
   * - B3 feature: r0 [l mobile].
   * - B4 main: r0 [m], its diff failed; n passed.
   * - B5 feature: r0 o, aborted.
   * - B6 feature, "Nightly 6": r0 [p] [q mobile]; r1 [r firefox].
   * - B7 main: r0 t passed.
   */
  async function mainWorld(): Promise<World> {
    const w = await world([
      {
        label: "B0",
        branch: "main",
        runs: [
          run(
            cp("a", "unresolved"),
            cp("b", "passed"),
            cp("c", "new", { viewport: MOBILE }),
          ),
          run(
            cp("d", "unresolved", { browser: "firefox" }),
            cp("e", "unresolved"),
          ),
        ],
      },
      {
        label: "B1",
        branch: "main",
        runs: [
          run(cp("f", "unresolved")),
          run(cp("g", "new")),
          { override: "failed", checkpoints: [cp("h", "unresolved")] },
        ],
      },
      {
        label: "B2",
        branch: "feature",
        runs: [
          { lifecycle: "running", checkpoints: [cp("i", "unresolved")] },
          run(cp("j", "unresolved"), cp("k", null)),
        ],
      },
      {
        label: "B3",
        branch: "feature",
        runs: [run(cp("l", "new", { viewport: MOBILE }))],
      },
      {
        label: "B4",
        branch: "main",
        runs: [run(cp("m", "new"), cp("n", "passed"))],
      },
      {
        label: "B5",
        branch: "feature",
        runs: [{ lifecycle: "aborted", checkpoints: [cp("o", "unresolved")] }],
      },
      {
        label: "B6",
        branch: "feature",
        runs: [
          run(
            cp("p", "unresolved"),
            cp("q", "unresolved", { viewport: MOBILE }),
          ),
          run(cp("r", "new", { browser: "firefox" })),
        ],
      },
      {
        label: "B7",
        branch: "main",
        runs: [run(cp("t", "passed"))],
      },
    ]);
    await decide(w, ["e"]);
    await decide(w, ["f"], { decision: "rejected" });
    await decide(w, ["g"], { reverted: true });
    await failDiff(w, "m");
    await h.db
      .update(builds)
      .set({ number: 11 })
      .where(eq(builds.id, w.id.B1!));
    await h.db
      .update(testRuns)
      .set({ name: "another-test" })
      .where(eq(testRuns.id, w.id["B1.r1"]!));
    await h.db
      .update(builds)
      .set({ name: "Nightly 6", number: 6 })
      .where(eq(builds.id, w.id.B6!));
    return w;
  }

  /**
   * The worst case (spec: every recent batch resolved): 14 batches W0..W13,
   * oldest first, alternating main / feature, each one run of `w<i>x`
   * (desktop) and `w<i>y` (mobile). Every batch but the two oldest has both
   * steps approved, so a newest-first walk finds its first pending batch
   * only at the end.
   */
  async function worstWorld(): Promise<World> {
    const n = 14;
    const w = await world(
      Array.from({ length: n }, (_, i) => ({
        label: `W${i}`,
        branch: i % 2 === 0 ? "main" : "feature",
        runs: [
          run(
            cp(`w${i}x`, "unresolved"),
            cp(`w${i}y`, "new", { viewport: MOBILE }),
          ),
        ],
      })),
    );
    await decide(
      w,
      Array.from({ length: n - 2 }, (_, k) => k + 2).flatMap((i) => [
        `w${i}x`,
        `w${i}y`,
      ]),
    );
    return w;
  }

  /** A position from labels. */
  const at = (
    w: World,
    build: string,
    run?: string,
    step?: string,
  ): QueueAt => ({
    buildId: w.id[build]!,
    ...(run ? { runId: w.id[run]! } : {}),
    ...(step ? { checkpointId: w.id[step]! } : {}),
  });

  /** The calls, by case name, on each world. */
  function mainCases(w: World): Record<string, () => Promise<unknown>> {
    const s = w.s;
    const ex = (...labels: string[]) => labels.map((l) => w.id[l]!);
    return {
      "main: pendingCount": () => pendingCount(s),
      "main: no at": () => next(s),
      "main: no at, prev": () => next(s, { direction: "prev" }),
      "main: no at, empty facets": () => next(s, { facets: {} }),
      "main: no at, mobile": () => next(s, { facets: mobile }),
      "main: no at, firefox": () => next(s, { facets: firefox }),
      "main: no at, a viewport no step has": () =>
        next(s, { facets: { viewport: "640x480" } }),
      "main: no at, newest excluded": () =>
        next(s, { excludeBuildIds: ex("B6") }),
      "main: no at, every pending batch excluded": () =>
        next(s, { excludeBuildIds: ex("B0", "B1", "B3", "B4", "B6") }),
      "main: at B0": () => next(s, { at: at(w, "B0") }),
      "main: at B0, prev": () =>
        next(s, { at: at(w, "B0"), direction: "prev" }),
      "main: at B0.r0": () => next(s, { at: at(w, "B0", "B0.r0") }),
      "main: at B0.r1": () => next(s, { at: at(w, "B0", "B0.r1") }),
      "main: at a": () => next(s, { at: at(w, "B0", "B0.r0", "a") }),
      "main: at b (passed)": () => next(s, { at: at(w, "B0", "B0.r0", "b") }),
      "main: at d, prev": () =>
        next(s, { at: at(w, "B0", "B0.r1", "d"), direction: "prev" }),
      "main: at a, firefox": () =>
        next(s, { at: at(w, "B0", "B0.r0", "a"), facets: firefox }),
      "main: at a, mobile": () =>
        next(s, { at: at(w, "B0", "B0.r0", "a"), facets: mobile }),
      "main: at c, mobile": () =>
        next(s, { at: at(w, "B0", "B0.r0", "c"), facets: mobile }),
      "main: at f (rejected)": () => next(s, { at: at(w, "B1", "B1.r0", "f") }),
      "main: at g (only pending of B1)": () =>
        next(s, { at: at(w, "B1", "B1.r1", "g") }),
      "main: at B2 (nothing pending)": () => next(s, { at: at(w, "B2") }),
      "main: at B2.r1": () => next(s, { at: at(w, "B2", "B2.r1") }),
      "main: at l (only pending of B3)": () =>
        next(s, { at: at(w, "B3", "B3.r0", "l") }),
      "main: at l, mobile": () =>
        next(s, { at: at(w, "B3", "B3.r0", "l"), facets: mobile }),
      "main: at m (diff failed, only pending of B4)": () =>
        next(s, { at: at(w, "B4", "B4.r0", "m") }),
      "main: at m, B1 excluded": () =>
        next(s, { at: at(w, "B4", "B4.r0", "m"), excludeBuildIds: ex("B1") }),
      "main: at B5": () => next(s, { at: at(w, "B5") }),
      "main: at p": () => next(s, { at: at(w, "B6", "B6.r0", "p") }),
      "main: at r, mobile": () =>
        next(s, { at: at(w, "B6", "B6.r1", "r"), facets: mobile }),
      "main: at r, prev": () =>
        next(s, { at: at(w, "B6", "B6.r1", "r"), direction: "prev" }),
      "main: at t, prev": () =>
        next(s, { at: at(w, "B7", "B7.r0", "t"), direction: "prev" }),
      "main: at B7, firefox": () =>
        next(s, { at: at(w, "B7"), facets: firefox }),
    };
  }

  function worstCases(w: World): Record<string, () => Promise<unknown>> {
    const s = w.s;
    return {
      "worst: pendingCount": () => pendingCount(s),
      "worst: no at": () => next(s),
      "worst: no at, mobile": () => next(s, { facets: mobile }),
      "worst: no at, W1 excluded": () =>
        next(s, { excludeBuildIds: [w.id.W1!] }),
      "worst: at W13": () => next(s, { at: at(w, "W13") }),
      "worst: at w12x": () => next(s, { at: at(w, "W12", "W12.r0", "w12x") }),
      "worst: at w13y, mobile": () =>
        next(s, { at: at(w, "W13", "W13.r0", "w13y"), facets: mobile }),
      "worst: at w1y, mobile": () =>
        next(s, { at: at(w, "W1", "W1.r0", "w1y"), facets: mobile }),
      "worst: at w0x, prev": () =>
        next(s, { at: at(w, "W0", "W0.r0", "w0x"), direction: "prev" }),
      "worst: at w1x": () => next(s, { at: at(w, "W1", "W1.r0", "w1x") }),
    };
  }

  test("every call answers what the condition-based reads answered (GOLDEN)", async () => {
    const main = await mainWorld();
    const worst = await worstWorld();
    const got: Record<string, unknown> = {};
    for (const [w, cases] of [
      [main, mainCases(main)],
      [worst, worstCases(worst)],
    ] as const) {
      for (const [name, call] of Object.entries(cases)) {
        got[name] = labelled(await call(), w);
      }
    }
    // Every id was labelled: a golden never holds a raw id.
    expect(JSON.stringify(got)).not.toMatch(UUID);
    expect(got).toEqual(GOLDEN);
  });

  /** `findNext`'s answer, labelled. */
  async function view(
    w: World,
    input: Omit<NextInput, "projectId"> = {},
  ): Promise<unknown> {
    return labelled(await next(w.s, input), w);
  }

  async function storedPending(w: World, run: string): Promise<number> {
    const [r] = await h.db
      .select({ pending: testRuns.pendingSteps })
      .from(testRuns)
      .where(eq(testRuns.id, w.id[run]!));
    return r!.pending;
  }

  /**
   * Writes a run's stored counter directly: the stale value a writer that
   * skipped `recomputeRunStatus` would leave. `fn` runs with it; the counter
   * is recomputed after, whatever happens.
   */
  async function withStoredPending(
    w: World,
    stale: Record<string, number>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const runIds = Object.keys(stale).map((run) => w.id[run]!);
    try {
      for (const [run, pending] of Object.entries(stale)) {
        await h.db
          .update(testRuns)
          .set({ pendingSteps: pending })
          .where(eq(testRuns.id, w.id[run]!));
      }
      await fn();
    } finally {
      await syncRunCounters(h.db, runIds);
    }
  }

  test("an overridden run's batch leaves the queue and the count", async () => {
    const w = await world([
      { label: "O0", branch: "main", runs: [run(cp("o0", "unresolved"))] },
      {
        label: "O1",
        branch: "main",
        runs: [
          run(cp("o1a", "unresolved")),
          run(cp("o1b", "unresolved", { viewport: MOBILE })),
        ],
      },
    ]);
    const client = makeClient(baseUrl, w.s.editor.jwt);
    const override = (
      runLabel: string,
      status: "passed" | "failed" | "default",
    ) => client.runs.overrideStatus.mutate({ runId: w.id[runLabel]!, status });

    expect(await pendingCount(w.s)).toBe(2);
    expect(await view(w)).toEqual({
      target: T("O1", "O1.r0", "o1a"),
      scope: "batch",
      remaining: R(0, 2, 2, 2),
      nextBatch: NB("O0", "run-*", "main", 1),
    });

    // One of O1's runs overridden: its step is out, the batch stays.
    await override("O1.r0", "passed");
    expect(await storedPending(w, "O1.r0")).toBe(0);
    expect(await pendingCount(w.s)).toBe(2);
    expect(await view(w)).toEqual({
      target: T("O1", "O1.r1", "o1b"),
      scope: "batch",
      remaining: R(0, 1, 1, 2),
      nextBatch: NB("O0", "run-*", "main", 1),
    });

    // Both: O1 leaves the count, and the queue under any facets.
    await override("O1.r1", "failed");
    expect(await pendingCount(w.s)).toBe(1);
    expect(await view(w)).toEqual({
      target: T("O0", "O0.r0", "o0"),
      scope: "batch",
      remaining: R(0, 1, 1, 1),
      nextBatch: null,
    });
    expect(await view(w, { facets: mobile })).toEqual({
      target: null,
      scope: "none",
      remaining: R(0, 0, 0, 0),
      nextBatch: null,
    });
    expect(await view(w, { at: at(w, "O0", "O0.r0", "o0") })).toEqual({
      target: null,
      scope: "none",
      remaining: R(0, 0, 0, 0),
      nextBatch: null,
    });
    expect(await view(w, { at: at(w, "O1") })).toEqual({
      target: T("O0", "O0.r0", "o0"),
      scope: "nextBatch",
      remaining: R(0, 0, 0, 1),
      nextBatch: NB("O0", "run-*", "main", 1),
    });

    // The override cleared: back in the queue and the count.
    await override("O1.r1", "default");
    expect(await pendingCount(w.s)).toBe(2);
    expect(await view(w, { facets: mobile })).toEqual({
      target: T("O1", "O1.r1", "o1b"),
      scope: "batch",
      remaining: R(0, 1, 1, 1),
      nextBatch: null,
    });
  });

  test("a batch whose only pending step is on another viewport is not offered under that facet", async () => {
    const w = await world([
      {
        label: "V0",
        branch: "main",
        runs: [
          run(
            cp("v0m", "unresolved", { viewport: MOBILE }),
            cp("v0d", "new", { viewport: DESKTOP }),
          ),
        ],
      },
      // The newer batch: pending on desktop only, so its run's counter is
      // above 0 while nothing in it is pending on mobile.
      {
        label: "V1",
        branch: "main",
        runs: [
          run(
            cp("v1d", "unresolved", { viewport: DESKTOP }),
            cp("v1m", "passed", { viewport: MOBILE }),
          ),
        ],
      },
    ]);
    expect(await storedPending(w, "V1.r0")).toBe(1);

    expect(await view(w, { facets: mobile })).toEqual({
      target: T("V0", "V0.r0", "v0m"),
      scope: "batch",
      remaining: R(0, 1, 2, 1),
      nextBatch: null,
    });
    expect(
      await view(w, { at: at(w, "V0", "V0.r0", "v0m"), facets: mobile }),
    ).toEqual({
      target: null,
      scope: "none",
      remaining: R(0, 0, 1, 0),
      nextBatch: null,
    });
    // From V1 under mobile, V0's pending number is its mobile steps only.
    expect(await view(w, { at: at(w, "V1"), facets: mobile })).toEqual({
      target: T("V0", "V0.r0", "v0m"),
      scope: "nextBatch",
      remaining: R(0, 0, 1, 1),
      nextBatch: NB("V0", "run-*", "main", 1),
    });
    // Unfiltered, V1 is offered, and V0 counts both of its steps.
    expect(await view(w, { at: at(w, "V0", "V0.r0", "v0m") })).toEqual({
      target: T("V0", "V0.r0", "v0d"),
      scope: "run",
      remaining: R(1, 1, 1, 2),
      nextBatch: NB("V1", "run-*", "main", 1),
    });
    expect(await view(w, { at: at(w, "V1") })).toMatchObject({
      nextBatch: NB("V0", "run-*", "main", 2),
    });
    expect(await pendingCount(w.s)).toBe(2);
  });

  test("unfiltered, the reads take the stored counters: a run stored at 0 is not pending, and a batch's pending number is its runs' sum", async () => {
    const w = await world([
      { label: "S0", branch: "main", runs: [run(cp("s0", "unresolved"))] },
      {
        label: "S1",
        branch: "main",
        runs: [run(cp("s1a", "unresolved"), cp("s1b", "new"))],
      },
      { label: "S2", branch: "main", runs: [run(cp("s2", "unresolved"))] },
    ]);
    // S2's step is still pending by its rows, but its run says 0; S1's run
    // says 7 for its two pending steps.
    await withStoredPending(w, { "S2.r0": 0, "S1.r0": 7 }, async () => {
      expect(await pendingCount(w.s)).toBe(2);
      expect(await view(w)).toEqual({
        target: T("S1", "S1.r0", "s1a"),
        scope: "batch",
        remaining: R(0, 2, 2, 2),
        nextBatch: NB("S0", "run-*", "main", 1),
      });
      expect(await view(w, { at: at(w, "S0", "S0.r0", "s0") })).toEqual({
        target: T("S1", "S1.r0", "s1a"),
        scope: "nextBatch",
        remaining: R(0, 0, 0, 1),
        nextBatch: NB("S1", "run-*", "main", 7),
      });
      // Inside its own batch the walk does not stop on S2's step either.
      expect(await view(w, { at: at(w, "S2") })).toEqual({
        target: T("S1", "S1.r0", "s1a"),
        scope: "nextBatch",
        remaining: R(0, 0, 0, 2),
        nextBatch: NB("S1", "run-*", "main", 7),
      });
    });
    // Recomputed: S2 is back, and S1 counts its two steps.
    expect(await pendingCount(w.s)).toBe(3);
    expect(await view(w, { at: at(w, "S0", "S0.r0", "s0") })).toEqual({
      target: T("S2", "S2.r0", "s2"),
      scope: "nextBatch",
      remaining: R(0, 0, 0, 2),
      nextBatch: NB("S2", "run-*", "main", 1),
    });
  });

  test("under a facet the steps decide, and the counters only pre-filter the runs", async () => {
    const w = await world([
      {
        label: "F0",
        branch: "main",
        runs: [run(cp("f0", "unresolved", { viewport: MOBILE }))],
      },
      {
        label: "F1",
        branch: "main",
        runs: [
          run(cp("f1d", "unresolved"), cp("f1m", "new", { viewport: MOBILE })),
        ],
      },
      { label: "F2", branch: "main", runs: [run(cp("f2d", "unresolved"))] },
    ]);
    // F2 pending on desktop only yet stored at 5; F1 stored at 9 for one
    // mobile step; F0's mobile step pending by its rows, but stored at 0.
    await withStoredPending(
      w,
      { "F2.r0": 5, "F1.r0": 9, "F0.r0": 0 },
      async () => {
        expect(await view(w, { facets: mobile })).toEqual({
          target: T("F1", "F1.r0", "f1m"),
          scope: "batch",
          remaining: R(0, 1, 2, 1),
          nextBatch: null,
        });
        expect(
          await view(w, { at: at(w, "F2", "F2.r0", "f2d"), facets: mobile }),
        ).toEqual({
          target: T("F1", "F1.r0", "f1m"),
          scope: "nextBatch",
          remaining: R(0, 0, 0, 1),
          nextBatch: NB("F1", "run-*", "main", 1),
        });
      },
    );
  });

  test("the newest pending batch is looked up from the pending batches, never by a walk of the project's batches", async () => {
    const w = await worstWorld();
    // findNext's raw statements: from the newest (resolved) batch, with the
    // only other pending batch on its branch excluded, the branch's probe and
    // then any branch's, with and without a facet.
    const statements: SQL[] = [];
    const capturing = (db: DB): DB =>
      new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== "execute" || typeof value !== "function") return value;
          return (q: SQL) => {
            statements.push(q);
            return (value as (q: SQL) => unknown).call(target, q);
          };
        },
      });
    for (const facets of [undefined, mobile]) {
      await withUserScope(
        h.app.db,
        { userId: w.s.editor.id, role: "editor", projectId: w.s.projectId },
        (tx) =>
          findNext(capturing(tx), {
            projectId: w.s.projectId,
            at: at(w, "W13"),
            excludeBuildIds: [w.id.W1!],
            ...(facets ? { facets } : {}),
          }),
      );
    }
    expect(statements).toHaveLength(4);
    for (const q of statements) {
      const plan = (
        await h.db.execute<{ "QUERY PLAN": string }>(
          sql`explain (costs off) ${q}`,
        )
      )
        .map((r) => r["QUERY PLAN"])
        .join("\n");
      // The pending batch ids first, each then read from `builds`, and the
      // candidates sorted: a walk of the batches in created_at order would
      // need no sort. (Which index serves the per-batch read is the
      // planner's; on these tiny tables it may pick either.)
      expect(plan).toContain("Function Scan on unnest pending_builds");
      expect(plan).toContain("Sort Key: b.created_at DESC, b.id DESC");
    }

    // With a facet the candidates are asked newest first and the probe stops
    // at the first match: of the main world's five pending batches, the
    // newest (B6) has a mobile pending step, so one is read past the sort.
    const main = await mainWorld();
    statements.length = 0;
    await withUserScope(
      h.app.db,
      { userId: main.s.editor.id, role: "editor", projectId: main.s.projectId },
      (tx) =>
        findNext(capturing(tx), {
          projectId: main.s.projectId,
          facets: mobile,
        }),
    );
    interface PlanNode {
      "Node Type": string;
      Alias?: string;
      "Sort Key"?: string[];
      "Actual Rows": number;
      Plans?: PlanNode[];
    }
    const [explained] = await h.db.execute<{ "QUERY PLAN": unknown }>(
      sql`explain (analyze, format json) ${statements[0]!}`,
    );
    const raw = explained!["QUERY PLAN"];
    const [{ Plan }] = (typeof raw === "string" ? JSON.parse(raw) : raw) as [
      { Plan: PlanNode },
    ];
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => {
      nodes.push(n);
      n.Plans?.forEach(walk);
    };
    walk(Plan);
    const candidates = nodes.find(
      (n) => n["Node Type"] === "Function Scan" && n.Alias === "pending_builds",
    );
    const sorted = nodes.find(
      (n) =>
        n["Node Type"] === "Sort" && n["Sort Key"]?.[0] === "b.created_at DESC",
    );
    expect([candidates?.["Actual Rows"], sorted?.["Actual Rows"]]).toEqual([
      5, 1,
    ]);
  });
});
