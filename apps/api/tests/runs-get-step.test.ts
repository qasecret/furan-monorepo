import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  builds,
  checkpointDecisions,
  diffRegions,
  eq,
  screenshots,
  sql,
  testRuns,
  testVariations,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import type { Context } from "../src/trpc/context.js";
import type { AppRouter } from "../src/trpc/v1/router.js";
import { runsRouter } from "../src/trpc/v1/runs.js";

import {
  bodyStatements,
  capturing,
  type CapturedStatement,
} from "./capturing-db.js";
import { createTestApp, type TestApp } from "./helpers.js";
import {
  addProjectEditor,
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  cp,
  seedReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
  type ReviewShot,
  type ReviewUser,
} from "./review-fixtures.js";

/**
 * `runs.getStep` (spec 2026-10-27 §5): one step of a run as the diff viewer
 * shows it. The goldens below are what the viewer read for a step before
 * getStep existed: the old `runs.getById` (the step's row, its
 * `checkpointContexts` entry, the run's regions filtered the viewer's way) and
 * the old `runs.listCheckpoints` extras (decision undo, actor, the newer
 * capture with its build name). Each golden is checked against those old reads
 * first, then getStep must return the same.
 */

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

function makeClient(baseUrl: string, jwt?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
      }),
    ],
  });
}

/** A row as the API serialises it (no transformer: dates are ISO strings). */
const wire = (row: unknown): unknown => JSON.parse(JSON.stringify(row));

/** Regions in a stable order: the old getById returned them unordered. */
const byId = <T extends { id: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

/**
 * The dashboard's `stepDiffKey` (apps/dashboard/src/components/diff-viewer/
 * step-diff-key.ts), rule for rule: the step's own diff image, else the run's
 * `diff_name`, which a step may borrow only as its run's one screenshot.
 */
function viewerDiffKey(
  step: { diffImageKey?: string | null } | null,
  run: { diffName?: string | null; screenshotCount: number },
): { key: string | null; legacyMissing: boolean } {
  const own = step?.diffImageKey ?? null;
  if (own !== null) return { key: own, legacyMissing: false };
  const legacyMissing = step !== null && run.screenshotCount > 1;
  return { key: legacyMissing ? null : (run.diffName ?? null), legacyMissing };
}

/** A per-step view: getStep's shape, what the goldens are written in. */
interface StepView {
  step: unknown;
  baselineContext: {
    baselineScreenshot: unknown;
    baselineSource: string | null;
    variationIgnoreAreas: unknown;
  };
  regions: Array<{ id: string }>;
  review: { verdict: unknown; state: unknown; decision: unknown };
  newerCapture: unknown;
}

/** 2026-02-01T00:00:00Z plus `sec` seconds, as a timestamptz literal. */
const at = (sec: number): string =>
  new Date(Date.UTC(2026, 1, 1) + sec * 1_000).toISOString();

d("runs.getStep", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  const as = (u: ReviewUser | null) => makeClient(baseUrl, u?.jwt);

  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec);
    seeds.push(s);
    return s;
  }

  /** The step's row as the API serialises it. */
  async function stepRow(id: string): Promise<unknown> {
    const [row] = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.id, id));
    return wire(row);
  }

  /**
   * The baseline run's capture of `shot`'s variation, the image its
   * `withBaseline` row stands for (the fixture seeds the row, not the image).
   * Captured as its run began.
   */
  async function addBaselineShot(
    s: ReviewSeed,
    shot: ReviewShot,
  ): Promise<unknown> {
    const [run] = await h.db
      .select({ createdAt: testRuns.createdAt })
      .from(testRuns)
      .where(eq(testRuns.id, s.baselineRunId!));
    const [row] = await h.db
      .insert(screenshots)
      .values({
        runId: s.baselineRunId!,
        projectId: s.projectId,
        testVariationId: shot.variationId,
        name: shot.name,
        viewport: shot.viewport,
        browser: shot.browser,
        imageKey: `baseline-${shot.name}-${randomUUID()}.png`,
        verdict: "passed",
        createdAt: run!.createdAt,
      })
      .returning();
    return wire(row);
  }

  /** A diff region of the run; `screenshotId` null is a pre-v1.1.20 row. */
  async function addRegion(
    s: ReviewSeed,
    runId: string,
    screenshotId: string | null,
    over: Partial<typeof diffRegions.$inferInsert> = {},
  ): Promise<{ id: string }> {
    const [row] = await h.db
      .insert(diffRegions)
      .values({
        runId,
        projectId: s.projectId,
        screenshotId,
        severity: "high",
        category: "layout",
        source: "pixel",
        description: "Pixel difference",
        bbox: { x: 1, y: 2, width: 3, height: 4 },
        viewport: "1280x720",
        ...over,
      })
      .returning();
    return wire(row) as { id: string };
  }

  async function reject(
    s: ReviewSeed,
    runId: string,
    shotIds: string[],
  ): Promise<string> {
    const actionId = randomUUID();
    await as(s.editor).review.reject.mutate({
      runId,
      actionId,
      checkpointIds: shotIds,
    });
    return actionId;
  }

  /**
   * What the viewer read for one step before getStep (DiffViewer.tsx): the
   * step's row from `getById.screenshots`, its `checkpointContexts` entry, the
   * run's regions on that step or on none (a pre-v1.1.20 row shows on every
   * step), and the review extras, which `listCheckpoints` reports the same.
   */
  async function oldStepView(
    user: ReviewUser,
    runId: string,
    stepId: string,
  ): Promise<StepView> {
    const c = as(user);
    const run = await c.runs.getById.query({ runId });
    const list = await c.runs.listCheckpoints.query({ runId });
    const ctx = run.checkpointContexts[stepId]!;
    const item = list.items.find((i) => i.id === stepId)!;
    const review = {
      verdict: ctx.verdict,
      state: ctx.state,
      decision: ctx.decision,
    };
    expect({
      verdict: item.verdict,
      state: item.state,
      decision: item.decision,
      newerCapture: item.newerCapture,
    }).toEqual({ ...review, newerCapture: ctx.newerCapture });
    return {
      step: run.screenshots.find((x) => x.id === stepId),
      baselineContext: {
        baselineScreenshot: ctx.baselineScreenshot,
        baselineSource: ctx.baselineSource,
        variationIgnoreAreas: ctx.variationIgnoreAreas,
      },
      regions: byId(
        run.diffRegions.filter(
          (r) => !r.screenshotId || r.screenshotId === stepId,
        ),
      ),
      review,
      newerCapture: ctx.newerCapture,
    };
  }

  /** getStep's answer, its regions in the goldens' order. */
  async function getStepView(
    user: ReviewUser,
    runId: string,
    stepId: string,
  ): Promise<StepView> {
    const v = await as(user).runs.getStep.query({
      runId,
      checkpointId: stepId,
    });
    return { ...v, regions: byId(v.regions) };
  }

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  beforeEach(() => {
    h.broadcasterPublish.mockReset();
    h.broadcasterPublish.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // The per-step context: a passed step, an unresolved one with regions, a new
  // one.
  // -------------------------------------------------------------------------

  /**
   * A run of three steps and their goldens: `p` passed (baseline image, one
   * severity-none region), `u` unresolved (baseline image, its variation's
   * ignore regions, two regions, rejected by the editor), `n` new (no
   * baseline, recaptured by a later run in the build "Release 7").
   */
  async function threeSteps() {
    const s = await seed({
      checkpoints: [
        { name: "p", verdict: "passed", withBaseline: true },
        { name: "u", verdict: "unresolved", withBaseline: true },
        { name: "n", verdict: "new" },
      ],
    });
    const [p, u, n] = [s.shots.p!, s.shots.u!, s.shots.n!];
    const baselineP = await addBaselineShot(s, p);
    const baselineU = await addBaselineShot(s, u);
    const ignore = [
      { x: 5, y: 6, width: 7, height: 8, viewport: "1280x720", kind: "ignore" },
    ];
    await h.db
      .update(testVariations)
      .set({ ignoreRegions: ignore })
      .where(eq(testVariations.id, u.variationId));
    const regionP = await addRegion(s, s.runId, p.id, { severity: "none" });
    const regionU1 = await addRegion(s, s.runId, u.id);
    const regionU2 = await addRegion(s, s.runId, u.id, {
      category: "color",
      bbox: { x: 40, y: 50, width: 60, height: 70 },
    });
    const actionId = await reject(s, s.runId, [u.id]);
    const later = await addReviewBuild(h, s, {
      spec: { checkpoints: [cp("n", "new")] },
    });
    await h.db
      .update(builds)
      .set({ name: "Release 7" })
      .where(eq(builds.id, later.buildId));
    const [decision] = await h.db
      .select()
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.screenshotId, u.id));

    const golden: Record<string, StepView> = {
      [p.id]: {
        step: await stepRow(p.id),
        baselineContext: {
          baselineScreenshot: baselineP,
          baselineSource: "this_branch",
          variationIgnoreAreas: null,
        },
        regions: [regionP],
        review: { verdict: "passed", state: "passed", decision: null },
        newerCapture: null,
      },
      [u.id]: {
        step: await stepRow(u.id),
        baselineContext: {
          baselineScreenshot: baselineU,
          baselineSource: "this_branch",
          variationIgnoreAreas: ignore,
        },
        regions: byId([regionU1, regionU2]),
        review: {
          verdict: "unresolved",
          state: "rejected",
          decision: {
            id: decision!.id,
            actionId,
            kind: "rejected",
            actor: { id: s.editor.id, name: s.editor.name },
            at: decision!.createdAt.toISOString(),
            source: "viewer",
            legacy: false,
            undo: { allowed: true },
          },
        },
        newerCapture: null,
      },
      [n.id]: {
        step: await stepRow(n.id),
        baselineContext: {
          baselineScreenshot: null,
          baselineSource: null,
          variationIgnoreAreas: null,
        },
        regions: [],
        review: { verdict: "new", state: "new", decision: null },
        newerCapture: {
          runId: later.runId,
          checkpointId: later.shots.n!.id,
          buildId: later.buildId,
          buildName: "Release 7",
        },
      },
    };
    return { s, steps: [p, u, n], golden };
  }

  /** The golden as another editor of the project sees it: not the decider. */
  function asPeer(view: StepView): StepView {
    const decision = view.review.decision as { undo: unknown } | null;
    if (decision === null) return view;
    return {
      ...view,
      review: {
        ...view.review,
        decision: {
          ...decision,
          undo: { allowed: false, reason: "not_decider" },
        },
      },
    };
  }

  describe("the per-step context", () => {
    test("golden: the old getById and listCheckpoints give each step's context", async () => {
      const { s, steps, golden } = await threeSteps();
      const peer = await addProjectEditor(h, s);
      for (const step of steps) {
        expect(await oldStepView(s.editor, s.runId, step.id)).toEqual(
          golden[step.id],
        );
        expect(await oldStepView(peer, s.runId, step.id)).toEqual(
          asPeer(golden[step.id]!),
        );
      }
    });

    test("getStep returns the same per-step context the old getById built", async () => {
      const { s, steps, golden } = await threeSteps();
      const peer = await addProjectEditor(h, s);
      for (const step of steps) {
        expect(await getStepView(s.editor, s.runId, step.id)).toEqual(
          golden[step.id],
        );
        // Undo is judged for the viewer getStep serves, as the old reads did.
        expect(await getStepView(peer, s.runId, step.id)).toEqual(
          asPeer(golden[step.id]!),
        );
      }
    });

    test("getStep returns the regions in capture order", async () => {
      const { s, steps, golden } = await threeSteps();
      const u = steps[1]!;
      // The region with the larger id was captured first, so capture order
      // is not id order.
      const [first, second] = golden[u.id]!.regions.map((r) => r.id).reverse();
      await h.db.execute(
        sql`update diff_regions set created_at = ${at(0)}::timestamptz where id = ${first!}`,
      );
      await h.db.execute(
        sql`update diff_regions set created_at = ${at(1)}::timestamptz where id = ${second!}`,
      );
      const v = await as(s.editor).runs.getStep.query({
        runId: s.runId,
        checkpointId: u.id,
      });
      expect(v.regions.map((r) => r.id)).toEqual([first, second]);
    });
  });

  // -------------------------------------------------------------------------
  // A legacy run: gen-0 steps with no diff image of their own, the run's
  // pre-0041 `diff_name`, pre-v1.1.20 regions on no step.
  // -------------------------------------------------------------------------

  /** A legacy run of `names` (one baseline image each) and its goldens. */
  async function legacyRun(names: string[]) {
    const s = await seed({
      checkpoints: names.map((name) => ({
        name,
        verdict: "unresolved" as const,
        withBaseline: true,
      })),
    });
    const diffName = `legacy-diff-${s.tag}.png`;
    await h.db
      .update(testRuns)
      .set({ diffName })
      .where(eq(testRuns.id, s.runId));
    // Pre-v1.1.20: no step, no viewport (v0.4). One newer region on step 1.
    const legacyRegion = await addRegion(s, s.runId, null, { viewport: null });
    const first = s.shotsInOrder[0]!;
    const ownRegion = await addRegion(s, s.runId, first.id);
    const golden: Record<string, StepView & { diff: unknown }> = {};
    for (const shot of s.shotsInOrder) {
      const baseline = await addBaselineShot(s, shot);
      golden[shot.id] = {
        step: await stepRow(shot.id),
        baselineContext: {
          baselineScreenshot: baseline,
          baselineSource: "this_branch",
          variationIgnoreAreas: null,
        },
        regions: byId(
          shot.id === first.id ? [legacyRegion, ownRegion] : [legacyRegion],
        ),
        review: { verdict: "unresolved", state: "unresolved", decision: null },
        newerCapture: null,
        // The run's image is its worst step's: only a run's one screenshot
        // may borrow it; on a run of several the step's image is lost.
        diff:
          names.length === 1
            ? { key: diffName, legacyMissing: false }
            : { key: null, legacyMissing: true },
      };
    }
    return { s, golden };
  }

  describe("a legacy run", () => {
    test("golden: the old getById's legacy context and diff fallback", async () => {
      for (const names of [["a", "b"], ["only"]]) {
        const { s, golden } = await legacyRun(names);
        const run = await as(s.editor).runs.getById.query({ runId: s.runId });
        for (const shot of s.shotsInOrder) {
          const { diff, ...view } = golden[shot.id]!;
          expect(await oldStepView(s.editor, s.runId, shot.id)).toEqual(view);
          const step = run.screenshots.find((x) => x.id === shot.id)!;
          expect(step.diffGeneration).toBe(0);
          expect(step.diffImageKey).toBeNull();
          expect(
            viewerDiffKey(step, {
              diffName: run.diffName,
              screenshotCount: run.screenshots.length,
            }),
          ).toEqual(diff);
        }
      }
    });

    test("getStep on a legacy run returns the same baseline context and legacy diff fallback as the old getById", async () => {
      for (const names of [["a", "b"], ["only"]]) {
        const { s, golden } = await legacyRun(names);
        // The fallback's run-side inputs are the run's own `diff_name` and its
        // step count, the rail's length (`checkpoint_count` is 0 on runs from
        // before it was kept).
        const run = await as(s.editor).runs.getById.query({ runId: s.runId });
        const rail = await as(s.editor).runs.listCheckpoints.query({
          runId: s.runId,
        });
        for (const shot of s.shotsInOrder) {
          const { diff, ...view } = golden[shot.id]!;
          const got = await getStepView(s.editor, s.runId, shot.id);
          expect(got).toEqual(view);
          expect(
            viewerDiffKey(got.step as { diffImageKey: string | null }, {
              diffName: run.diffName,
              screenshotCount: rail.items.length,
            }),
          ).toEqual(diff);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // The gate, and a step that is not the run's
  // -------------------------------------------------------------------------

  describe("the gate and NOT_FOUND", () => {
    test("getStep for a step not in the run is NOT_FOUND", async () => {
      const s = await seed({ checkpoints: [cp("a", "unresolved")] });
      const other = await addReviewRun(h, s, {
        checkpoints: [cp("b", "unresolved")],
      });
      for (const user of [s.editor, s.admin]) {
        // The run's own step is found: the procedure is there.
        await expect(
          as(user).runs.getStep.query({
            runId: s.runId,
            checkpointId: s.shots.a!.id,
          }),
        ).resolves.toMatchObject({ step: { id: s.shots.a!.id } });
        // An unknown step, and a step of another run of the same build.
        for (const checkpointId of [randomUUID(), other.shots.b!.id]) {
          await expect(
            as(user).runs.getStep.query({ runId: s.runId, checkpointId }),
          ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
        }
      }
      // An unknown run.
      await expect(
        as(s.editor).runs.getStep.query({
          runId: randomUUID(),
          checkpointId: s.shots.a!.id,
        }),
      ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    });

    test("a step of another project is NOT_FOUND, even one that claims this run", async () => {
      const s = await seed({ checkpoints: [cp("a", "unresolved")] });
      const foreign = await seed({ checkpoints: [cp("z", "unresolved")] });
      // Another project's step, asked for under this run (the foreign step
      // itself is found under its own run).
      await expect(
        as(foreign.editor).runs.getStep.query({
          runId: foreign.runId,
          checkpointId: foreign.shots.z!.id,
        }),
      ).resolves.toMatchObject({ step: { id: foreign.shots.z!.id } });
      for (const user of [s.editor, s.admin]) {
        await expect(
          as(user).runs.getStep.query({
            runId: s.runId,
            checkpointId: foreign.shots.z!.id,
          }),
        ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
      }
      // Corrupt data: a row of the foreign project that points at this run.
      const [stray] = await h.db
        .insert(screenshots)
        .values({
          runId: s.runId,
          projectId: foreign.projectId,
          testVariationId: foreign.shots.z!.variationId,
          name: "stray",
          viewport: "1280x720",
          browser: "chromium",
          imageKey: `stray-${s.tag}.png`,
          verdict: "unresolved",
        })
        .returning({ id: screenshots.id });
      for (const user of [s.editor, s.admin]) {
        await expect(
          as(user).runs.getStep.query({
            runId: s.runId,
            checkpointId: stray!.id,
          }),
        ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
      }
      await h.db.delete(screenshots).where(eq(screenshots.id, stray!.id));
    });

    test("getStep never reports another project's decision on the step", async () => {
      const s = await seed({ checkpoints: [cp("a", "unresolved")] });
      const foreign = await seed({ checkpoints: [cp("z", "unresolved")] });
      // Corrupt data: an active decision of the foreign project on this step.
      await h.db.insert(checkpointDecisions).values({
        projectId: foreign.projectId,
        runId: s.runId,
        screenshotId: s.shots.a!.id,
        actionId: randomUUID(),
        decision: "approved",
        actorId: foreign.editor.id,
        source: "viewer",
        before: null,
      });
      // Admins see every project: the pin is in the query, not the role.
      for (const user of [s.editor, s.admin]) {
        const v = await as(user).runs.getStep.query({
          runId: s.runId,
          checkpointId: s.shots.a!.id,
        });
        expect(v.review).toEqual({
          verdict: "unresolved",
          state: "unresolved",
          decision: null,
        });
      }
    });

    test("getStep is gated like the neighbouring reads", async () => {
      const s = await seed({ checkpoints: [cp("a", "unresolved")] });
      const input = { runId: s.runId, checkpointId: s.shots.a!.id };
      await expect(as(null).runs.getStep.query(input)).rejects.toMatchObject({
        data: { code: "UNAUTHORIZED" },
      });
      for (const user of [s.outsider, s.guest]) {
        await expect(as(user).runs.getStep.query(input)).rejects.toMatchObject({
          data: { code: "FORBIDDEN" },
        });
      }
      for (const user of [s.editor, s.admin]) {
        const v = await as(user).runs.getStep.query(input);
        expect((v.step as { id: string }).id).toBe(s.shots.a!.id);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Statement count
  // -------------------------------------------------------------------------

  describe("statement count", () => {
    /**
     * A run of `n` unresolved steps, each with a baseline image and a region,
     * all rejected in one action (the undo assessment reads the whole action),
     * and a later run that recaptures step `s0`: every branch of the read runs
     * for `s0`, however many steps sit beside it.
     */
    async function runOf(n: number): Promise<ReviewSeed> {
      const s = await seed({
        checkpoints: Array.from({ length: n }, (_, i) => ({
          name: `s${i}`,
          verdict: "unresolved" as const,
          withBaseline: true,
        })),
      });
      const [baselineRun] = await h.db
        .select({ createdAt: testRuns.createdAt })
        .from(testRuns)
        .where(eq(testRuns.id, s.baselineRunId!));
      await h.db.insert(screenshots).values(
        s.shotsInOrder.map((shot) => ({
          runId: s.baselineRunId!,
          projectId: s.projectId,
          testVariationId: shot.variationId,
          name: shot.name,
          viewport: shot.viewport,
          browser: shot.browser,
          imageKey: `baseline-${shot.name}-${s.tag}.png`,
          verdict: "passed" as const,
          createdAt: baselineRun!.createdAt,
        })),
      );
      await h.db.insert(diffRegions).values(
        s.shotsInOrder.map((shot) => ({
          runId: s.runId,
          projectId: s.projectId,
          screenshotId: shot.id,
          severity: "high",
          category: "layout",
          source: "pixel",
          description: "Pixel difference",
          bbox: { x: 1, y: 2, width: 3, height: 4 },
          viewport: shot.viewport,
        })),
      );
      await reject(
        s,
        s.runId,
        s.shotsInOrder.map((x) => x.id),
      );
      await addReviewRun(h, s, { checkpoints: [cp("s0", "unresolved")] });
      return s;
    }

    /** getStep through the router, with the statements it issued. */
    async function counted(user: ReviewUser, runId: string, stepId: string) {
      const statements: CapturedStatement[] = [];
      const view = await runsRouter
        .createCaller({
          user: { id: user.id, role: user.role, via: "jwt" },
          db: capturing(h.db, statements),
          telemetry: h.telemetry,
        } as unknown as Context)
        .getStep({ runId, checkpointId: stepId });
      return { view, count: bodyStatements(statements).length };
    }

    test("getStep's statement count does not grow with the run's step count", async () => {
      const small = await runOf(5);
      const big = await runOf(200);
      for (const who of ["editor", "admin"] as const) {
        const a = await counted(small[who], small.runId, small.shots.s0!.id);
        const b = await counted(big[who], big.runId, big.shots.s0!.id);
        // Every branch ran: a baseline, a region, a decision with its undo,
        // a newer capture.
        for (const { view } of [a, b]) {
          expect(view.baselineContext.baselineSource).toBe("this_branch");
          expect(view.regions).toHaveLength(1);
          expect(view.review.decision?.undo).toEqual({ allowed: true });
          expect(view.newerCapture).not.toBeNull();
        }
        expect(a.count).toBeGreaterThan(0);
        expect(b.count).toBe(a.count);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The newer capture (spec 2026-10-23 §5.6): of the step's variation, the
  // newest capture in a run captured after this one, in capture order of
  // runs (`created_at, id`), in this run's project; on any branch.
  // -------------------------------------------------------------------------

  interface NewerCase {
    user: ReviewUser;
    runId: string;
    stepId: string;
    /** The run and step named; and the build's name, when the case pins it. */
    expected: {
      runId: string;
      checkpointId: string;
      buildName?: string;
    } | null;
  }

  async function stampRun(runId: string, sec: number): Promise<void> {
    await h.db.execute(
      sql`update test_runs set created_at = ${at(sec)}::timestamptz where id = ${runId}`,
    );
  }
  async function stampStep(stepId: string, sec: number): Promise<void> {
    await h.db.execute(
      sql`update screenshots set created_at = ${at(sec)}::timestamptz where id = ${stepId}`,
    );
  }

  /** Each scenario seeds its project and says what each step's answer is. */
  const scenarios: Record<string, () => Promise<NewerCase[]>> = {
    "several later captures: the newest; the newest run: none": async () => {
      const s = await seed({ checkpoints: [cp("a", "unresolved")] });
      const r1 = await addReviewRun(h, s, {
        checkpoints: [cp("a", "unresolved")],
      });
      const r2 = await addReviewRun(h, s, {
        checkpoints: [cp("a", "unresolved")],
      });
      const newest = { runId: r2.runId, checkpointId: r2.shots.a!.id };
      return [
        {
          user: s.editor,
          runId: s.runId,
          stepId: s.shots.a!.id,
          expected: newest,
        },
        {
          user: s.editor,
          runId: r1.runId,
          stepId: r1.shots.a!.id,
          expected: newest,
        },
        {
          user: s.editor,
          runId: r2.runId,
          stepId: r2.shots.a!.id,
          expected: null,
        },
      ];
    },

    "the later RUN wins, though a run created before it captured later":
      async () => {
        // r1 created at 10, captured at 50; r2 created at 20, captured at 30.
        const s = await seed({ checkpoints: [cp("a", "unresolved")] });
        const r1 = await addReviewRun(h, s, {
          checkpoints: [cp("a", "unresolved")],
        });
        const r2 = await addReviewRun(h, s, {
          checkpoints: [cp("a", "unresolved")],
        });
        await stampRun(s.runId, 0);
        await stampStep(s.shots.a!.id, 1);
        await stampRun(r1.runId, 10);
        await stampStep(r1.shots.a!.id, 50);
        await stampRun(r2.runId, 20);
        await stampStep(r2.shots.a!.id, 30);
        const r2a = { runId: r2.runId, checkpointId: r2.shots.a!.id };
        return [
          {
            user: s.editor,
            runId: s.runId,
            stepId: s.shots.a!.id,
            expected: r2a,
          },
          {
            user: s.editor,
            runId: r1.runId,
            stepId: r1.shots.a!.id,
            expected: r2a,
          },
          {
            user: s.editor,
            runId: r2.runId,
            stepId: r2.shots.a!.id,
            expected: null,
          },
        ];
      },

    "an earlier run's capture made after this run began is not newer":
      async () => {
        // `early` was created first (at -10) but captured last (at 40).
        const s = await seed({ checkpoints: [cp("a", "unresolved")] });
        const early = await addReviewRun(h, s, {
          checkpoints: [cp("a", "unresolved")],
        });
        await stampRun(early.runId, -10);
        await stampStep(early.shots.a!.id, 40);
        await stampRun(s.runId, 0);
        await stampStep(s.shots.a!.id, 1);
        return [
          {
            user: s.editor,
            runId: s.runId,
            stepId: s.shots.a!.id,
            expected: null,
          },
          {
            user: s.editor,
            runId: early.runId,
            stepId: early.shots.a!.id,
            expected: { runId: s.runId, checkpointId: s.shots.a!.id },
          },
        ];
      },

    "a tie on the run's created_at goes to the larger run id": async () => {
      const s = await seed({ checkpoints: [cp("a", "unresolved")] });
      const x = await addReviewRun(h, s, {
        checkpoints: [cp("a", "unresolved")],
      });
      const y = await addReviewRun(h, s, {
        checkpoints: [cp("a", "unresolved")],
      });
      const [lo, hi] = [x, y].sort((m, n) => m.runId.localeCompare(n.runId));
      await stampRun(s.runId, 0);
      await stampStep(s.shots.a!.id, 1);
      // Both created at 10; the smaller id captured later, so the newest
      // capture is not the newest run's.
      await stampRun(lo!.runId, 10);
      await stampStep(lo!.shots.a!.id, 20);
      await stampRun(hi!.runId, 10);
      await stampStep(hi!.shots.a!.id, 15);
      const hiA = { runId: hi!.runId, checkpointId: hi!.shots.a!.id };
      return [
        {
          user: s.editor,
          runId: s.runId,
          stepId: s.shots.a!.id,
          expected: hiA,
        },
        {
          user: s.editor,
          runId: lo!.runId,
          stepId: lo!.shots.a!.id,
          expected: hiA,
        },
        {
          user: s.editor,
          runId: hi!.runId,
          stepId: hi!.shots.a!.id,
          expected: null,
        },
      ];
    },

    "a tie on the capture time goes to the later run, not the larger step id":
      async () => {
        const s = await seed({ checkpoints: [cp("a", "unresolved")] });
        const x = await addReviewRun(h, s, {
          checkpoints: [cp("a", "unresolved")],
        });
        const y = await addReviewRun(h, s, {
          checkpoints: [cp("a", "unresolved")],
        });
        // The run whose step has the smaller id is the later run (20, not 10);
        // both captured at 30.
        const [later, earlier] = [x, y].sort((m, n) =>
          m.shots.a!.id.localeCompare(n.shots.a!.id),
        );
        await stampRun(s.runId, 0);
        await stampStep(s.shots.a!.id, 1);
        await stampRun(earlier!.runId, 10);
        await stampStep(earlier!.shots.a!.id, 30);
        await stampRun(later!.runId, 20);
        await stampStep(later!.shots.a!.id, 30);
        const want = { runId: later!.runId, checkpointId: later!.shots.a!.id };
        return [
          {
            user: s.editor,
            runId: s.runId,
            stepId: s.shots.a!.id,
            expected: want,
          },
          {
            user: s.editor,
            runId: earlier!.runId,
            stepId: earlier!.shots.a!.id,
            expected: want,
          },
          {
            user: s.editor,
            runId: later!.runId,
            stepId: later!.shots.a!.id,
            expected: null,
          },
        ];
      },

    "a later run on another branch that captured the variation counts":
      async () => {
        // A branch merge copies a step, variation and all, into a run on the
        // target branch: "newer" does not look at the branch.
        const s = await seed({ checkpoints: [cp("a", "unresolved")] });
        const merged = await addReviewBuild(h, s, {
          branch: "main",
          spec: { checkpoints: [cp("z", "passed")] },
        });
        const [copy] = await h.db
          .insert(screenshots)
          .values({
            runId: merged.runId,
            projectId: s.projectId,
            testVariationId: s.shots.a!.variationId,
            name: "a",
            viewport: "1280x720",
            browser: "chromium",
            imageKey: s.shots.a!.imageKey,
            verdict: "passed",
          })
          .returning({ id: screenshots.id });
        await stampRun(s.runId, 0);
        await stampStep(s.shots.a!.id, 1);
        await stampRun(merged.runId, 10);
        await stampStep(merged.shots.z!.id, 11);
        await stampStep(copy!.id, 12);
        return [
          {
            user: s.editor,
            runId: s.runId,
            stepId: s.shots.a!.id,
            expected: { runId: merged.runId, checkpointId: copy!.id },
          },
        ];
      },

    "another project's capture of the variation is never named": async () => {
      const s = await seed({ checkpoints: [cp("a", "unresolved")] });
      const foreign = await seed({ checkpoints: [cp("z", "unresolved")] });
      // Corrupt data: a foreign project's step pointing at s's variation.
      await h.db.insert(screenshots).values({
        runId: foreign.runId,
        projectId: foreign.projectId,
        testVariationId: s.shots.a!.variationId,
        name: "alias",
        viewport: "1280x720",
        browser: "chromium",
        imageKey: `alias-${s.tag}.png`,
        verdict: "unresolved",
      });
      await stampRun(s.runId, 0);
      await stampStep(s.shots.a!.id, 1);
      await stampRun(foreign.runId, 10);
      // Admins see every project: the pin is in the query, not the role.
      return [s.editor, s.admin].map((user) => ({
        user,
        runId: s.runId,
        stepId: s.shots.a!.id,
        expected: null,
      }));
    },

    // Not a golden of the old code, which named the foreign build: the build
    // is read in this project only (as `runByName` never names another
    // project's build's runner).
    "a later run in another project's build: that build is never named":
      async () => {
        const s = await seed({ checkpoints: [cp("a", "unresolved")] });
        const foreign = await seed({ checkpoints: [cp("z", "unresolved")] });
        await h.db
          .update(builds)
          .set({ name: "Foreign 9", number: 9, ciBuildId: "ci-foreign-0123" })
          .where(eq(builds.id, foreign.buildId));
        const later = await addReviewRun(h, s, {
          checkpoints: [cp("a", "unresolved")],
        });
        // Corrupt data: the later run sits in the foreign project's build.
        await h.db
          .update(testRuns)
          .set({ buildId: foreign.buildId })
          .where(eq(testRuns.id, later.runId));
        // Named by its build id alone, as a build the reader cannot see is:
        // never the foreign build's name, number, CI id or test name.
        const want = {
          runId: later.runId,
          checkpointId: later.shots.a!.id,
          buildName: foreign.buildId.slice(0, 8),
        };
        return [s.editor, s.admin].map((user) => ({
          user,
          runId: s.runId,
          stepId: s.shots.a!.id,
          expected: want,
        }));
      },
  };

  /**
   * `newerCapture` reduced to what the case pins: the run and its step, and
   * the build's name when the case names one.
   */
  const pinned = (
    n:
      | { runId: string; checkpointId: string; buildName: string }
      | null
      | undefined,
    want: NewerCase["expected"],
  ) =>
    n
      ? {
          runId: n.runId,
          checkpointId: n.checkpointId,
          ...(want?.buildName !== undefined ? { buildName: n.buildName } : {}),
        }
      : null;

  // Every scenario but the last is a golden of the old code (green on
  // 5d23f7f0); the last pins the build lookup to the project.
  describe("the newer capture, as the existing reads report it", () => {
    for (const [name, scenario] of Object.entries(scenarios)) {
      test(name, async () => {
        for (const c of await scenario()) {
          const list = await as(c.user).runs.listCheckpoints.query({
            runId: c.runId,
          });
          const run = await as(c.user).runs.getById.query({ runId: c.runId });
          expect(
            pinned(
              list.items.find((i) => i.id === c.stepId)!.newerCapture,
              c.expected,
            ),
          ).toEqual(c.expected);
          expect(
            pinned(run.checkpointContexts[c.stepId]!.newerCapture, c.expected),
          ).toEqual(c.expected);
        }
      });
    }
  });

  describe("the newer capture, as getStep reports it", () => {
    for (const [name, scenario] of Object.entries(scenarios)) {
      test(name, async () => {
        for (const c of await scenario()) {
          const v = await as(c.user).runs.getStep.query({
            runId: c.runId,
            checkpointId: c.stepId,
          });
          expect(pinned(v.newerCapture, c.expected)).toEqual(c.expected);
        }
      });
    }
  });
});
