import { randomUUID } from "node:crypto";

import {
  and,
  checkpointDecisions,
  eq,
  inArray,
  screenshots,
  testRuns,
  type DB,
} from "@furan/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  facetCondition,
  pendingStepCondition,
  type StepFacets,
} from "../src/lib/review/pending.js";
import {
  selectGroupTargets,
  selectPendingTargets,
} from "../src/lib/review/targets.js";

import { createTestApp, type TestApp } from "./helpers.js";
import { pendingCountsByBuild, pendingCountsByRun } from "./pending-oracle.js";
import {
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  syncRunCounters,
  type ReviewRunSpec,
  type ReviewSeed,
} from "./review-fixtures.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

d("the SQL definition of a pending review step", () => {
  let h: TestApp;
  const seeds: ReviewSeed[] = [];

  async function seed(
    spec: ReviewRunSpec,
    opts?: { branch?: string },
  ): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec, opts);
    seeds.push(s);
    return s;
  }

  /** A decision row (an approve unless `decision`), active unless `reverted`. */
  async function decide(
    s: ReviewSeed,
    runId: string,
    shotId: string,
    opts: { reverted?: boolean; decision?: "approved" | "rejected" } = {},
  ): Promise<void> {
    await h.db.insert(checkpointDecisions).values({
      projectId: s.projectId,
      runId,
      screenshotId: shotId,
      actionId: randomUUID(),
      decision: opts.decision ?? "approved",
      actorId: s.editor.id,
      source: "viewer",
      before: null,
      revertedAt: opts.reverted ? new Date() : null,
      revertedBy: opts.reverted ? s.editor.id : null,
    });
  }

  /** The `{runId, screenshotId}` keys `pendingStepCondition` selects in a build. */
  async function pendingInBuild(
    db: DB,
    buildId: string,
    facets?: StepFacets,
  ): Promise<string[]> {
    const rows = await db
      .select({ runId: screenshots.runId, screenshotId: screenshots.id })
      .from(screenshots)
      .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
      .where(and(eq(testRuns.buildId, buildId), pendingStepCondition(facets)));
    return rows.map((r) => `${r.runId}:${r.screenshotId}`).sort();
  }

  const key = (runId: string, screenshotId: string) =>
    `${runId}:${screenshotId}`;

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  test("pendingStepCondition selects exactly selectPendingTargets' set", async () => {
    // (a) one step of each verdict
    const s = await seed({
      checkpoints: [
        { name: "a-new", verdict: "new" },
        { name: "a-unresolved", verdict: "unresolved" },
        { name: "a-passed", verdict: "passed" },
      ],
    });

    // (b) unresolved, with an active approve
    const b = await addReviewRun(h, s, {
      lifecycle: "passed",
      checkpoints: [{ name: "b", verdict: "unresolved" }],
    });
    await decide(s, b.runId, b.shots.b!.id);

    // (c) unresolved, its approve reverted: pending again
    const c = await addReviewRun(h, s, {
      checkpoints: [{ name: "c", verdict: "unresolved" }],
    });
    await decide(s, c.runId, c.shots.c!.id, { reverted: true });

    // (b2) unresolved, with an active reject: any active decision excludes
    // the step, not only an approve
    const b2 = await addReviewRun(h, s, {
      lifecycle: "failed",
      checkpoints: [{ name: "b2", verdict: "unresolved" }],
    });
    await decide(s, b2.runId, b2.shots.b2!.id, { decision: "rejected" });

    // (d) lifecycle running, (e) aborted, (f) empty: not reviewable
    await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [{ name: "d", verdict: "unresolved" }],
    });
    await addReviewRun(h, s, {
      lifecycle: "aborted",
      checkpoints: [{ name: "e", verdict: "unresolved" }],
    });
    await addReviewRun(h, s, {
      lifecycle: "empty",
      checkpoints: [{ name: "f", verdict: "unresolved" }],
    });

    // (g) overridden to failed: not reviewable until reset
    await addReviewRun(h, s, {
      override: "failed",
      checkpoints: [{ name: "g", verdict: "unresolved" }],
    });

    // (h) a sibling not yet diffed makes the whole run non-reviewable. The
    // lifecycle is set so that only the NULL verdict can exclude it.
    await addReviewRun(h, s, {
      lifecycle: "failed",
      checkpoints: [
        { name: "h-unresolved", verdict: "unresolved" },
        { name: "h-undiffed", verdict: null },
      ],
    });

    const viaSql = await pendingInBuild(h.db, s.buildId);
    const { targets } = await selectPendingTargets(
      h.db,
      { projectId: s.projectId, buildId: s.buildId },
      10_000,
    );
    const viaTargets = targets.map((t) => key(t.runId, t.screenshotId)).sort();

    expect(viaSql).toEqual(viaTargets);
    expect(viaSql).toEqual(
      [
        key(s.runId, s.shots["a-new"]!.id),
        key(s.runId, s.shots["a-unresolved"]!.id),
        key(c.runId, c.shots.c!.id),
      ].sort(),
    );
  });

  test("selectGroupTargets selects exactly selectPendingTargets' group", async () => {
    // The legality cases above, every step on one signature, plus a pending
    // step on another signature and one whose diff failed.
    const s = await seed({
      checkpoints: [
        { name: "a-new", verdict: "new" },
        { name: "a-unresolved", verdict: "unresolved" },
        { name: "a-passed", verdict: "passed" },
        { name: "a-other-signature", verdict: "unresolved" },
      ],
    });
    const b = await addReviewRun(h, s, {
      lifecycle: "passed",
      checkpoints: [{ name: "b", verdict: "unresolved" }],
    });
    await decide(s, b.runId, b.shots.b!.id);
    const c = await addReviewRun(h, s, {
      checkpoints: [{ name: "c", verdict: "unresolved" }],
    });
    await decide(s, c.runId, c.shots.c!.id, { reverted: true });
    const b2 = await addReviewRun(h, s, {
      lifecycle: "failed",
      checkpoints: [{ name: "b2", verdict: "unresolved" }],
    });
    await decide(s, b2.runId, b2.shots.b2!.id, { decision: "rejected" });
    const notReviewable = [
      await addReviewRun(h, s, {
        lifecycle: "running",
        checkpoints: [{ name: "d", verdict: "unresolved" }],
      }),
      await addReviewRun(h, s, {
        lifecycle: "aborted",
        checkpoints: [{ name: "e", verdict: "unresolved" }],
      }),
      await addReviewRun(h, s, {
        lifecycle: "empty",
        checkpoints: [{ name: "f", verdict: "unresolved" }],
      }),
      await addReviewRun(h, s, {
        override: "failed",
        checkpoints: [{ name: "g", verdict: "unresolved" }],
      }),
      await addReviewRun(h, s, {
        lifecycle: "failed",
        checkpoints: [
          { name: "h-unresolved", verdict: "unresolved" },
          { name: "h-undiffed", verdict: null },
        ],
      }),
    ];
    const failed = await addReviewRun(h, s, {
      checkpoints: [{ name: "i-failed", verdict: "unresolved" }],
    });
    await h.db
      .update(screenshots)
      .set({ diffFailedAt: new Date(), diffError: "timeout" })
      .where(eq(screenshots.id, failed.shots["i-failed"]!.id));
    // The decisions and the failure went in by SQL: recompute the counters.
    await syncRunCounters(h.db, [b.runId, c.runId, b2.runId, failed.runId]);

    const sig = `sig-${s.tag}`;
    const signed = [s, b, c, b2, ...notReviewable, failed].flatMap((r) =>
      r.shotsInOrder
        .filter((x) => x.name !== "a-other-signature")
        .map((x) => x.id),
    );
    await h.db
      .update(screenshots)
      .set({ diffSignature: sig })
      .where(inArray(screenshots.id, signed));
    await h.db
      .update(screenshots)
      .set({ diffSignature: `other-${s.tag}` })
      .where(eq(screenshots.id, s.shots["a-other-signature"]!.id));

    const scope = {
      projectId: s.projectId,
      buildId: s.buildId,
      diffSignature: sig,
    };
    const { targets: viaTargets } = await selectPendingTargets(
      h.db,
      scope,
      10_000,
    );
    const viaSql = await selectGroupTargets(h.db, { ...scope, limit: 201 });
    const keys = (ts: Array<{ runId: string; screenshotId: string }>) =>
      ts.map((t) => key(t.runId, t.screenshotId));
    expect(keys(viaSql.targets)).toEqual(keys(viaTargets));
    expect(viaSql.total).toBe(viaTargets.length);
    expect(keys(viaSql.targets)).toEqual([
      key(s.runId, s.shots["a-new"]!.id),
      key(s.runId, s.shots["a-unresolved"]!.id),
      key(c.runId, c.shots.c!.id),
    ]);
  });

  test("facets narrow per step", async () => {
    const s = await seed({
      checkpoints: [
        { name: "home", verdict: "unresolved", viewport: "1280x720" },
        { name: "home", verdict: "unresolved", viewport: "375x812" },
      ],
    });
    const [desktop, mobile] = s.shotsInOrder;
    expect(desktop!.viewport).toBe("1280x720");
    expect(mobile!.viewport).toBe("375x812");

    expect(await pendingInBuild(h.db, s.buildId)).toEqual(
      [key(s.runId, desktop!.id), key(s.runId, mobile!.id)].sort(),
    );
    expect(
      await pendingInBuild(h.db, s.buildId, { viewport: "375x812" }),
    ).toEqual([key(s.runId, mobile!.id)]);
    expect(
      await pendingInBuild(h.db, s.buildId, { viewport: "1280x720" }),
    ).toEqual([key(s.runId, desktop!.id)]);
    expect(
      await pendingInBuild(h.db, s.buildId, { viewport: "1024x768" }),
    ).toEqual([]);
  });

  test("browser, os and device facets are exact matches that combine with AND", async () => {
    const s = await seed({
      checkpoints: [
        { name: "plain", verdict: "new" },
        { name: "ff", verdict: "new", browser: "firefox" },
        { name: "mac", verdict: "new", os: "macOS" },
        {
          name: "pixel",
          verdict: "new",
          viewport: "412x915",
          os: "Android",
          device: "Pixel 7",
        },
      ],
    });
    const only = (name: string) => [key(s.runId, s.shots[name]!.id)];

    expect(
      await pendingInBuild(h.db, s.buildId, { browser: "firefox" }),
    ).toEqual(only("ff"));
    expect(await pendingInBuild(h.db, s.buildId, { os: "macOS" })).toEqual(
      only("mac"),
    );
    expect(
      await pendingInBuild(h.db, s.buildId, { device: "Pixel 7" }),
    ).toEqual(only("pixel"));
    expect(
      await pendingInBuild(h.db, s.buildId, {
        os: "Android",
        device: "Pixel 7",
        viewport: "412x915",
      }),
    ).toEqual(only("pixel"));
    // Two facets that no single step satisfies together.
    expect(
      await pendingInBuild(h.db, s.buildId, {
        browser: "firefox",
        os: "macOS",
      }),
    ).toEqual([]);
    // The default environment: chromium on 1280x720.
    expect(
      (
        await pendingInBuild(h.db, s.buildId, {
          browser: "chromium",
          viewport: "1280x720",
        })
      ).sort(),
    ).toEqual([...only("plain"), ...only("mac")].sort());
  });

  test("pendingStepCondition pre-filters on the active-decision flag and keeps the NOT EXISTS", () => {
    const { sql: text } = h.db
      .select({ id: screenshots.id })
      .from(screenshots)
      .where(pendingStepCondition())
      .toSQL();
    // The index-usable pre-filter (ADR-074): a literal, never a bound
    // parameter, so the partial index's predicate is provably implied.
    expect(text).toContain(`not "screenshots"."has_active_decision"`);
    // The canonical test stays: correctness never depends on the flag.
    expect(text).toMatch(
      /not exists \(select 1 from "checkpoint_decisions" where "checkpoint_decisions"\."screenshot_id" = "screenshots"\."id" and "checkpoint_decisions"\."reverted_at" is null\)/,
    );
  });

  test("facetCondition is undefined until a facet is set", () => {
    expect(facetCondition()).toBeUndefined();
    expect(facetCondition({})).toBeUndefined();
    expect(facetCondition({ viewport: "375x812" })).toBeDefined();
  });

  test("pendingCountsByRun / ByBuild", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a-new", verdict: "new" },
        { name: "a-unresolved", verdict: "unresolved" },
        { name: "a-passed", verdict: "passed" },
      ],
    });
    // Nothing pending: every step passed.
    const allPassed = await addReviewRun(h, s, {
      checkpoints: [{ name: "b", verdict: "passed" }],
    });
    // Two pending, one already approved.
    const partly = await addReviewRun(h, s, {
      checkpoints: [
        { name: "c1", verdict: "unresolved" },
        { name: "c2", verdict: "unresolved" },
        { name: "c3", verdict: "unresolved" },
      ],
    });
    await decide(s, partly.runId, partly.shots.c3!.id);
    // Not reviewable, so nothing pending.
    const running = await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [{ name: "d", verdict: "unresolved" }],
    });
    // A second build: one pending step on another branch, and a build with
    // nothing pending.
    const other = await addReviewBuild(h, s, {
      branch: "feature/other",
      spec: { checkpoints: [{ name: "e", verdict: "unresolved" }] },
    });
    const quiet = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "f", verdict: "passed" }] },
    });

    const runIds = [
      s.runId,
      allPassed.runId,
      partly.runId,
      running.runId,
      other.runId,
      quiet.runId,
    ];
    const byRun = await pendingCountsByRun(h.db, {
      projectId: s.projectId,
      runIds,
    });
    expect(Object.fromEntries(byRun)).toEqual({
      [s.runId]: 2,
      [partly.runId]: 2,
      [other.runId]: 1,
    });
    expect(byRun.has(allPassed.runId)).toBe(false);
    expect(byRun.has(running.runId)).toBe(false);
    expect(byRun.has(quiet.runId)).toBe(false);

    const byBuild = await pendingCountsByBuild(h.db, {
      projectId: s.projectId,
      buildIds: [s.buildId, other.buildId, quiet.buildId],
    });
    expect(Object.fromEntries(byBuild)).toEqual({
      [s.buildId]: 4,
      [other.buildId]: 1,
    });
    expect(byBuild.has(quiet.buildId)).toBe(false);

    // Only the asked-for ids are counted.
    const justOther = await pendingCountsByBuild(h.db, {
      projectId: s.projectId,
      buildIds: [other.buildId],
    });
    expect(Object.fromEntries(justOther)).toEqual({ [other.buildId]: 1 });

    // Facets apply to the counts too.
    const mobile = await addReviewRun(h, s, {
      checkpoints: [
        { name: "m", verdict: "new", viewport: "375x812" },
        { name: "m", verdict: "new", viewport: "1280x720" },
      ],
    });
    const faceted = await pendingCountsByRun(h.db, {
      projectId: s.projectId,
      runIds: [s.runId, mobile.runId],
      facets: { viewport: "375x812" },
    });
    expect(Object.fromEntries(faceted)).toEqual({ [mobile.runId]: 1 });
    const facetedBuild = await pendingCountsByBuild(h.db, {
      projectId: s.projectId,
      buildIds: [s.buildId],
      facets: { viewport: "375x812" },
    });
    expect(Object.fromEntries(facetedBuild)).toEqual({ [s.buildId]: 1 });

    // No ids, no query, no counts.
    expect(
      (await pendingCountsByRun(h.db, { projectId: s.projectId, runIds: [] }))
        .size,
    ).toBe(0);
    expect(
      (
        await pendingCountsByBuild(h.db, {
          projectId: s.projectId,
          buildIds: [],
        })
      ).size,
    ).toBe(0);
  });

  test("a foreign project's run contributes nothing", async () => {
    const mine = await seed({
      checkpoints: [{ name: "x", verdict: "unresolved" }],
    });
    const theirs = await seed({
      checkpoints: [{ name: "x", verdict: "unresolved" }],
    });

    const own = await pendingCountsByRun(h.db, {
      projectId: theirs.projectId,
      runIds: [theirs.runId],
    });
    expect(Object.fromEntries(own)).toEqual({ [theirs.runId]: 1 });

    const foreignRun = await pendingCountsByRun(h.db, {
      projectId: theirs.projectId,
      runIds: [mine.runId],
    });
    expect(foreignRun.size).toBe(0);

    const foreignBuild = await pendingCountsByBuild(h.db, {
      projectId: theirs.projectId,
      buildIds: [mine.buildId],
    });
    expect(foreignBuild.size).toBe(0);

    // Asking for both: only the caller's project is counted.
    const both = await pendingCountsByRun(h.db, {
      projectId: theirs.projectId,
      runIds: [mine.runId, theirs.runId],
    });
    expect(Object.fromEntries(both)).toEqual({ [theirs.runId]: 1 });
  });
});
