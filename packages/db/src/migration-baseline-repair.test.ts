import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  baselines,
  builds,
  createDb,
  eq,
  inArray,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "./index.js";

/**
 * Migration `0036_baseline_repair` (review-flow spec §4.4).
 *
 * Before the approve core promoted every checkpoint, run-level approve and batch
 * "Approve all" promoted ONE arbitrary checkpoint per run (and the diff-worker
 * paired every checkpoint with a single baseline run by viewport). The other
 * checkpoints' variations were left with no baseline or a stale one. The
 * migration repairs them from the legacy marker `status = 'passed' AND
 * merge = true`, and audits every row it writes.
 *
 * There is no programmatic migrator, so — like `migration-0006.test.ts` — we
 * seed LEGACY-shaped rows on the already-migrated database, then run the
 * migration file's own statements (split on `--> statement-breakpoint`) via
 * `db.execute`, and assert. Everything is scoped to this test's own variations
 * and runs: the statements are global, so they will also touch any other
 * legacy-shaped rows that happen to be in the throwaway test database.
 *
 * Skipped when `DATABASE_URL` is unset — same convention as the other
 * migration tests in this package.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0036_baseline_repair.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

const HOUR = 3_600_000;

describe.runIf(RUN_INTEGRATION)("0036_baseline_repair migration", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID().slice(0, 8);
  /** A fixed reference point; runs and baselines are seeded relative to it.
   *  600h back, so even `at(520)` lies in the past. */
  const T0 = Date.now() - 600 * HOUR;
  const at = (hours: number): Date => new Date(T0 + hours * HOUR);

  let projectId: string;
  let buildId: string;
  let approverId: string;
  const userIds: string[] = [];
  /** Every variation id this test seeds; cleanup finds the baselines (and so the
   *  audit_log rows, which have no FK) through them. */
  const touchedVariationIds: string[] = [];

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;

    const [u] = await db
      .insert(users)
      .values({
        email: `baseline-repair-${tag}@t.example`,
        hashedPassword: "x",
        firstName: "baseline",
        lastName: "repair",
        role: "editor",
      })
      .returning();
    approverId = u!.id;
    userIds.push(approverId);

    const [p] = await db
      .insert(projects)
      .values({ name: `baseline-repair-${tag}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId: approverId, isRunning: false })
      .returning();
    buildId = b!.id;
  });

  afterAll(async () => {
    // audit_log has no FK to baselines, so sweep the repair rows by target.
    if (touchedVariationIds.length > 0) {
      const ids = await db
        .select({ id: baselines.id })
        .from(baselines)
        .where(inArray(baselines.testVariationId, touchedVariationIds));
      if (ids.length > 0) {
        await db.delete(auditLog).where(
          inArray(
            auditLog.targetId,
            ids.map((r) => r.id),
          ),
        );
      }
    }
    // projects cascade to builds / runs / screenshots / variations / baselines.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await close();
  });

  // --- seed helpers ---------------------------------------------------------

  async function seedVariation(
    name: string,
    branchName = "main",
  ): Promise<string> {
    const [v] = await db
      .insert(testVariations)
      .values({
        name: `${name}-${tag}-${randomUUID().slice(0, 6)}`,
        projectId,
        branchName,
      })
      .returning();
    touchedVariationIds.push(v!.id);
    return v!.id;
  }

  async function seedRun(opts: {
    status: (typeof testRuns.$inferInsert)["status"];
    merge: boolean;
    createdAt: Date;
    /** Pinned explicitly (default: createdAt) — it is the acceptance-time
     *  fallback for a run that owns no baselines row, so it must not be "now". */
    updatedAt?: Date;
    branchName?: string | null;
    /** Variations this run has a screenshot of (image keys come back keyed). */
    variationIds: string[];
  }): Promise<{ runId: string; keys: Record<string, string> }> {
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `run-${randomUUID()}`,
        status: opts.status,
        merge: opts.merge,
        createdAt: opts.createdAt,
        updatedAt: opts.updatedAt ?? opts.createdAt,
        branchName: opts.branchName === undefined ? "main" : opts.branchName,
      })
      .returning();
    const runId = r!.id;
    const keys: Record<string, string> = {};
    let i = 0;
    for (const variationId of opts.variationIds) {
      const imageKey = `img-${randomUUID()}`;
      keys[variationId] = imageKey;
      await db.insert(screenshots).values({
        runId,
        projectId,
        testVariationId: variationId,
        name: `step-${i++}`,
        viewport: "1280x720",
        browser: "chromium",
        imageKey,
        createdAt: opts.createdAt,
      });
    }
    return { runId, keys };
  }

  async function seedBaseline(opts: {
    variationId: string;
    runId: string;
    createdAt: Date;
    userId?: string | null;
    branchName?: string;
    baselineName?: string;
  }): Promise<string> {
    const [b] = await db
      .insert(baselines)
      .values({
        testVariationId: opts.variationId,
        testRunId: opts.runId,
        userId: opts.userId ?? null,
        branchName: opts.branchName ?? "main",
        baselineName: opts.baselineName ?? "seed",
        createdAt: opts.createdAt,
      })
      .returning();
    return b!.id;
  }

  /** Run the migration file exactly as drizzle's migrator does: split on the
   *  breakpoint marker, execute each statement. */
  async function runMigration(): Promise<void> {
    const statements = MIGRATION_SQL.split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }
  }

  /** Current (newest) baseline row for a variation on a branch. */
  async function currentBaseline(variationId: string, branch = "main") {
    const rows = await db.execute<{
      id: string;
      test_run_id: string;
      baseline_name: string | null;
      user_id: string | null;
      branch_name: string;
    }>(sql`
      SELECT id, test_run_id, baseline_name, user_id, branch_name
      FROM baselines
      WHERE test_variation_id = ${variationId} AND branch_name = ${branch}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    return rows[0];
  }

  async function baselineRows(variationId: string) {
    return db
      .select()
      .from(baselines)
      .where(eq(baselines.testVariationId, variationId));
  }

  async function repairAuditFor(baselineIds: string[]) {
    if (baselineIds.length === 0) return [];
    return db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.targetId, baselineIds));
  }

  // --- the migration file ---------------------------------------------------

  it("is a non-empty data migration that audits as baseline.repair", () => {
    const body = MIGRATION_SQL.replace(/--.*$/gm, "").trim();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/baseline\.repair/);
  });

  // --- behaviour ------------------------------------------------------------

  it("repairs the unpromoted checkpoints of a passed + merged multi-checkpoint run, with audit", async () => {
    const home = await seedVariation("home");
    const cart = await seedVariation("cart");
    const checkout = await seedVariation("checkout");

    // `checkout` carries a STALE baseline from an older approved run.
    const old = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(1),
      variationIds: [checkout],
    });
    const staleId = await seedBaseline({
      variationId: checkout,
      runId: old.runId,
      createdAt: at(2),
      userId: approverId,
    });

    // The legacy multi-checkpoint run: approved, but only `home` promoted.
    const run = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(10),
      variationIds: [home, cart, checkout],
    });
    const homeBaselineId = await seedBaseline({
      variationId: home,
      runId: run.runId,
      createdAt: at(11),
      userId: approverId,
      baselineName: run.keys[home]!,
    });

    await runMigration();

    // `home` already pointed at the run: untouched, no new row, no audit.
    const homeRows = await baselineRows(home);
    expect(homeRows.map((r) => r.id)).toEqual([homeBaselineId]);
    expect(homeRows[0]!.createdAt.getTime()).toBe(at(11).getTime());

    // `cart` had none: now has a row pointing at this run's own image.
    const cartRows = await baselineRows(cart);
    expect(cartRows).toHaveLength(1);
    expect(cartRows[0]).toMatchObject({
      testRunId: run.runId,
      baselineName: run.keys[cart],
      branchName: "main",
      userId: approverId, // the run's existing approver
    });
    // Written "now": newer than every seeded timestamp, so it is the current one.
    expect(cartRows[0]!.createdAt.getTime()).toBeGreaterThan(at(11).getTime());
    expect((await currentBaseline(cart))!.id).toBe(cartRows[0]!.id);

    // `checkout` had a stale one: a NEW row for this run is now the current one,
    // and the stale row is kept as history.
    const checkoutRows = await baselineRows(checkout);
    expect(checkoutRows).toHaveLength(2);
    const current = await currentBaseline(checkout);
    expect(current).toMatchObject({
      test_run_id: run.runId,
      baseline_name: run.keys[checkout],
      user_id: approverId,
    });
    expect(current!.id).not.toBe(staleId);

    // Exactly 2 audit rows for the 3 checkpoints — one per row written.
    const audits = await repairAuditFor([
      homeBaselineId,
      cartRows[0]!.id,
      current!.id,
    ]);
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.action === "baseline.repair")).toBe(true);
    expect(audits.every((a) => a.targetType === "baseline")).toBe(true);
    expect(audits.every((a) => a.actorId === null)).toBe(true);
    const byTarget = new Map(audits.map((a) => [a.targetId, a.metadata]));
    expect(byTarget.get(cartRows[0]!.id)).toEqual({
      variationId: cart,
      runId: run.runId,
      branch: "main",
      previousBaselineId: null,
      op: "inserted",
    });
    expect(byTarget.get(current!.id)).toEqual({
      variationId: checkout,
      runId: run.runId,
      branch: "main",
      previousBaselineId: staleId,
      op: "inserted",
    });
  });

  it("leaves a variation alone when its newest baseline is newer than the newest approved run", async () => {
    // (a) the newest approved run IS what the baseline points at.
    const a = await seedVariation("pricing");
    const aOld = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(20),
      variationIds: [a],
    });
    const aNew = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(30),
      variationIds: [a],
    });
    const aBaseline = await seedBaseline({
      variationId: a,
      runId: aNew.runId,
      createdAt: at(31),
    });
    void aOld;

    // (b) the baseline points at a run NEWER than the only approved run
    //     (e.g. a baseline promoted by a path that never flagged the run).
    const b = await seedVariation("docs");
    await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(20),
      variationIds: [b],
    });
    const bLater = await seedRun({
      status: "unresolved",
      merge: false,
      createdAt: at(40),
      variationIds: [b],
    });
    const bBaseline = await seedBaseline({
      variationId: b,
      runId: bLater.runId,
      createdAt: at(41),
    });

    await runMigration();

    expect((await baselineRows(a)).map((r) => r.id)).toEqual([aBaseline]);
    expect((await baselineRows(b)).map((r) => r.id)).toEqual([bBaseline]);
    expect(await repairAuditFor([aBaseline, bBaseline])).toHaveLength(0);
  });

  it("is idempotent: a second run writes no baselines and no audit rows", async () => {
    const home = await seedVariation("idem-home");
    const cart = await seedVariation("idem-cart");
    const run = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(50),
      variationIds: [home, cart],
    });
    await seedBaseline({
      variationId: home,
      runId: run.runId,
      createdAt: at(51),
      userId: approverId,
    });

    await runMigration();

    const snapshot = async () => {
      const rows = await db
        .select({
          id: baselines.id,
          vid: baselines.testVariationId,
          rid: baselines.testRunId,
          createdAt: baselines.createdAt,
          updatedAt: baselines.updatedAt,
        })
        .from(baselines)
        .where(inArray(baselines.testVariationId, [home, cart]));
      const audits = await repairAuditFor(rows.map((r) => r.id));
      return {
        rows: rows
          .map(
            (r) =>
              `${r.id}|${r.createdAt.toISOString()}|${r.updatedAt.toISOString()}`,
          )
          .sort(),
        audits: audits.map((a) => a.id).sort(),
      };
    };

    const first = await snapshot();
    expect(first.rows).toHaveLength(2);
    expect(first.audits).toHaveLength(1);

    await runMigration();
    await runMigration();

    // Nothing inserted, nothing re-stamped, no extra audit rows.
    expect(await snapshot()).toEqual(first);
  });

  it("never uses a run that is not passed + merged as a source", async () => {
    const statuses = [
      "unresolved",
      "new",
      "failed",
      "aborted",
      "empty",
      "running",
    ] as const;
    const variationIds: string[] = [];
    for (const status of statuses) {
      // merge=true on a non-passed run is still never a source.
      const v = await seedVariation(`never-${status}`);
      variationIds.push(v);
      await seedRun({
        status,
        merge: true,
        createdAt: at(60),
        variationIds: [v],
      });
    }
    // passed but NOT merged (never promoted) is not a source either.
    const unmerged = await seedVariation("never-unmerged");
    variationIds.push(unmerged);
    await seedRun({
      status: "passed",
      merge: false,
      createdAt: at(60),
      variationIds: [unmerged],
    });

    await runMigration();

    for (const v of variationIds) {
      expect(await baselineRows(v)).toHaveLength(0);
    }
  });

  it("does not let a newer non-approved run hide, or become, the source", async () => {
    const v = await seedVariation("mixed");
    const approved = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(70),
      variationIds: [v],
    });
    // Newer runs in every non-approved shape must be ignored.
    await seedRun({
      status: "unresolved",
      merge: false,
      createdAt: at(71),
      variationIds: [v],
    });
    await seedRun({
      status: "new",
      merge: true,
      createdAt: at(72),
      variationIds: [v],
    });

    await runMigration();

    const rows = await baselineRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      testRunId: approved.runId,
      baselineName: approved.keys[v],
    });
  });

  it("picks the NEWEST approved run, breaking created_at ties on id", async () => {
    const v = await seedVariation("newest");
    await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(80),
      variationIds: [v],
    });
    const newest = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(82),
      variationIds: [v],
    });

    // Two approved runs with an identical created_at: the larger id wins.
    const t = await seedVariation("tie");
    const tieA = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(90),
      variationIds: [t],
    });
    const tieB = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(90),
      variationIds: [t],
    });
    const expectedTie = tieA.runId > tieB.runId ? tieA : tieB;

    await runMigration();

    const rows = await baselineRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.testRunId).toBe(newest.runId);

    const tieRows = await baselineRows(t);
    expect(tieRows).toHaveLength(1);
    expect(tieRows[0]!.testRunId).toBe(expectedTie.runId);
  });

  it("repairs per (variation, branch) and skips runs with no branch", async () => {
    const v = await seedVariation("branches");
    const mainRun = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(100),
      branchName: "main",
      variationIds: [v],
    });
    const featRun = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(101),
      branchName: `feature-${tag}`,
      variationIds: [v],
    });
    // A run with no branch can never be matched to a baseline branch.
    const noBranch = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(102),
      branchName: null,
      variationIds: [v],
    });
    void noBranch;

    await runMigration();

    const rows = await baselineRows(v);
    expect(rows).toHaveLength(2);
    const byBranch = new Map(rows.map((r) => [r.branchName, r]));
    expect(byBranch.get("main")!.testRunId).toBe(mainRun.runId);
    expect(byBranch.get(`feature-${tag}`)!.testRunId).toBe(featRun.runId);
  });

  it("moves an existing (variation, run) row stranded on another branch in place, once", async () => {
    // The unique key is (variation, run), so the insert conflicts with this row;
    // the update must move it onto the run's branch or the repair would never
    // converge (and would re-audit on every run). It keeps its created_at (it
    // is, by construction, already the newest on that branch) and its approver.
    const [otherUser] = await db
      .insert(users)
      .values({
        email: `baseline-repair-other-${tag}@t.example`,
        hashedPassword: "x",
        firstName: "baseline",
        lastName: "other",
        role: "editor",
      })
      .returning();
    userIds.push(otherUser!.id);
    // The repair's candidate approver is MIN(user_id::text) over the run's rows,
    // so give the stranded row the LARGER user and a sibling row the SMALLER:
    // "keep the existing approver" and "take the candidate" then differ.
    const [low, high] = [approverId, otherUser!.id].sort() as [string, string];

    const v = await seedVariation("stranded");
    const sibling = await seedVariation("stranded-sibling");
    const run = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(110),
      branchName: `feature-${tag}`,
      variationIds: [v],
    });
    const strandedId = await seedBaseline({
      variationId: v,
      runId: run.runId,
      createdAt: at(111),
      userId: high,
      branchName: "main",
      baselineName: "stale-name",
    });
    // Another approver already recorded on the same run (for a step this
    // migration has no screenshot for, so it is not itself a candidate).
    await seedBaseline({
      variationId: sibling,
      runId: run.runId,
      createdAt: at(112),
      userId: low,
      branchName: `feature-${tag}`,
    });

    await runMigration();

    const rows = await baselineRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: strandedId,
      branchName: `feature-${tag}`,
      baselineName: run.keys[v],
      userId: high, // kept: a repair never replaces an existing approver
    });
    // Not re-stamped: the moved row keeps the time it was really accepted.
    expect(rows[0]!.createdAt.getTime()).toBe(at(111).getTime());
    const audits = await repairAuditFor([strandedId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({
      variationId: v,
      runId: run.runId,
      branch: `feature-${tag}`,
      previousBaselineId: null,
      op: "updated",
    });

    await runMigration();
    expect(await repairAuditFor([strandedId])).toHaveLength(1);
  });

  it("is idempotent when it moves a stranded row that is the run's only baseline", async () => {
    // Regression: the moved row is the run's ONLY (hence earliest) acceptance.
    // If a re-run stopped counting it, the run would fall back to updated_at,
    // which lies after a sibling's current baseline, and that sibling would be
    // "repaired" on pass 2, overriding a newer baseline.
    const featureBranch = `feature-${tag}`;
    const v1 = await seedVariation("only-v1");
    const v2 = await seedVariation("only-v2");

    const run = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(100),
      updatedAt: at(130),
      branchName: featureBranch,
      variationIds: [v1, v2],
    });
    const strandedId = await seedBaseline({
      variationId: v1,
      runId: run.runId,
      createdAt: at(110),
      userId: approverId,
      branchName: "main",
    });
    // v2's current baseline sits between the run's first acceptance (110) and
    // its updated_at (130), on an unrelated (unresolved) run.
    const other = await seedRun({
      status: "unresolved",
      merge: false,
      createdAt: at(115),
      branchName: featureBranch,
      variationIds: [v2],
    });
    const v2Current = await seedBaseline({
      variationId: v2,
      runId: other.runId,
      createdAt: at(120),
      branchName: featureBranch,
    });

    const snapshot = async () => {
      const rows = await db
        .select()
        .from(baselines)
        .where(inArray(baselines.testVariationId, [v1, v2]));
      const audits = await repairAuditFor(rows.map((r) => r.id));
      return {
        rows: rows
          .map(
            (r) =>
              `${r.id}|${r.branchName}|${r.createdAt.toISOString()}|${r.updatedAt.toISOString()}`,
          )
          .sort(),
        audits: audits.map((a) => a.id).sort(),
      };
    };

    await runMigration();
    const first = await snapshot();
    // v1's stranded row moved onto the run's branch; v2 is untouched.
    expect(first.rows).toHaveLength(2);
    expect((await baselineRows(v2)).map((r) => r.id)).toEqual([v2Current]);
    expect(first.audits).toHaveLength(1);

    // Passes 2 and 3 write nothing: no new baselines, no new audit rows.
    await runMigration();
    expect(await snapshot()).toEqual(first);
    await runMigration();
    expect(await snapshot()).toEqual(first);

    const [movedAudit] = await repairAuditFor([strandedId]);
    expect(movedAudit!.metadata).toMatchObject({ op: "updated" });
  });

  it("takes user_id from any baseline already on the run, else NULL", async () => {
    const withUser = await seedVariation("user-yes");
    const withoutUser = await seedVariation("user-no");
    const anchor = await seedVariation("user-anchor");

    const run = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(120),
      variationIds: [anchor, withUser],
    });
    await seedBaseline({
      variationId: anchor,
      runId: run.runId,
      createdAt: at(121),
      userId: approverId,
    });

    // An auto-approved run: no baseline on the run carries a user.
    const auto = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(122),
      variationIds: [withoutUser],
    });
    void auto;

    await runMigration();

    expect((await baselineRows(withUser))[0]!.userId).toBe(approverId);
    expect((await baselineRows(withoutUser))[0]!.userId).toBeNull();
  });

  it("does not modify test_variations.baseline_name", async () => {
    const v = await seedVariation("denorm");
    await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(130),
      variationIds: [v],
    });

    await runMigration();

    const [row] = await db
      .select({ baselineName: testVariations.baselineName })
      .from(testVariations)
      .where(eq(testVariations.id, v));
    expect(row!.baselineName).toBeNull();
  });
  // --- "newer" means newer ACCEPTANCE, not newer run creation (ruling R13) ----

  it("respects a deliberate later re-approval of an older run's step", async () => {
    const v1 = await seedVariation("reapprove-v1");
    const v2 = await seedVariation("reapprove-v2");
    const v3 = await seedVariation("reapprove-v3");

    // Two approved runs of the same 2-step test; `later` is also the only run
    // that has the (new) third step.
    const earlier = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(200),
      variationIds: [v1, v2],
    });
    const later = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(210),
      variationIds: [v1, v2, v3],
    });
    // earlier was approved at t(201); later at t3 = t(211) (its first checkpoint)...
    const v1Earlier = await seedBaseline({
      variationId: v1,
      runId: earlier.runId,
      createdAt: at(201),
      userId: approverId,
    });
    const v1Later = await seedBaseline({
      variationId: v1,
      runId: later.runId,
      createdAt: at(211),
      userId: approverId,
    });
    // ...and then step 2 of the OLDER run was deliberately re-approved, after t3.
    const v2Earlier = await seedBaseline({
      variationId: v2,
      runId: earlier.runId,
      createdAt: at(212),
      userId: approverId,
    });

    await runMigration();

    // v2: the re-approval is respected (run creation order would have said
    // "later is newer" and overwritten it).
    expect((await baselineRows(v2)).map((r) => r.id)).toEqual([v2Earlier]);
    // v1: earlier's later re-approval of ANOTHER step must not drag step 1 back
    // to the older run — step 1's own newest acceptance is on `later`.
    expect((await baselineRows(v1)).map((r) => r.id).sort()).toEqual(
      [v1Earlier, v1Later].sort(),
    );
    expect((await currentBaseline(v1))!.id).toBe(v1Later);
    // v3 (only `later` has it, no baseline yet) is still repaired.
    const v3Rows = await baselineRows(v3);
    expect(v3Rows).toHaveLength(1);
    expect(v3Rows[0]).toMatchObject({
      testRunId: later.runId,
      baselineName: later.keys[v3],
    });
    expect(await repairAuditFor([v1Earlier, v1Later, v2Earlier])).toHaveLength(
      0,
    );
    expect(await repairAuditFor([v3Rows[0]!.id])).toHaveLength(1);

    // Re-run: the repaired v3 row (stamped "now") must NOT inflate `later`'s
    // acceptance time past the re-approval and flip v2 on the second pass.
    await runMigration();
    expect((await baselineRows(v2)).map((r) => r.id)).toEqual([v2Earlier]);
    expect((await baselineRows(v1)).map((r) => r.id).sort()).toEqual(
      [v1Earlier, v1Later].sort(),
    );
    expect(await baselineRows(v3)).toHaveLength(1);
    expect(await repairAuditFor([v3Rows[0]!.id])).toHaveLength(1);
  });

  it("repairs when the newer-approved run was created BEFORE the run holding the current baseline", async () => {
    const v1 = await seedVariation("interleave-v1");
    const v2 = await seedVariation("interleave-v2");

    // `late` is created first but approved last; `early` is created after it
    // but approved (step 2 at t1' = t(305)) before `late` was (step 1 at t3 =
    // t(310)). Creation order would call `early` the newer run and do nothing.
    const late = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(300),
      variationIds: [v1, v2],
    });
    const early = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(301),
      variationIds: [v1, v2],
    });
    const v1Early = await seedBaseline({
      variationId: v1,
      runId: early.runId,
      createdAt: at(302),
      userId: approverId,
    });
    const v2Early = await seedBaseline({
      variationId: v2,
      runId: early.runId,
      createdAt: at(305),
      userId: approverId,
    });
    const v1Late = await seedBaseline({
      variationId: v1,
      runId: late.runId,
      createdAt: at(310),
      userId: approverId,
    });

    await runMigration();

    // v1 is already on its newest acceptance: untouched.
    expect((await baselineRows(v1)).map((r) => r.id).sort()).toEqual(
      [v1Early, v1Late].sort(),
    );
    // v2 was accepted at t(305) < t(310) when `late` was approved: repaired to
    // `late`, the stale row kept as history and named as previousBaselineId.
    const v2Rows = await baselineRows(v2);
    expect(v2Rows).toHaveLength(2);
    const current = await currentBaseline(v2);
    expect(current).toMatchObject({
      test_run_id: late.runId,
      baseline_name: late.keys[v2],
    });
    const [audit] = await repairAuditFor([current!.id]);
    expect(audit!.metadata).toEqual({
      variationId: v2,
      runId: late.runId,
      branch: "main",
      previousBaselineId: v2Early,
      op: "inserted",
    });

    await runMigration();
    expect(await baselineRows(v2)).toHaveLength(2);
    expect(await repairAuditFor([current!.id])).toHaveLength(1);
  });

  it("uses a run's first acceptance as its run-level approval time, not a later single-step re-approval", async () => {
    const v1 = await seedVariation("firstacc-v1");
    const v2 = await seedVariation("firstacc-v2");
    const v3 = await seedVariation("firstacc-v3");

    // Both runs have all three steps; neither owns a baselines row for v3.
    const older = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(500),
      variationIds: [v1, v2, v3],
    });
    const newer = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(510),
      variationIds: [v1, v2, v3],
    });
    // `older` approved run-level at t1; `newer` approved at t3 > t1...
    const v1Older = await seedBaseline({
      variationId: v1,
      runId: older.runId,
      createdAt: at(501),
      userId: approverId,
    });
    const v1Newer = await seedBaseline({
      variationId: v1,
      runId: newer.runId,
      createdAt: at(511),
      userId: approverId,
    });
    // ...then ONE step of the older run is re-approved much later, t4 > t3.
    const v2Older = await seedBaseline({
      variationId: v2,
      runId: older.runId,
      createdAt: at(520),
      userId: approverId,
    });

    await runMigration();

    // v3 has no baseline: it comes from the run approved as a whole most
    // recently (`newer`, t3), not from `older`, whose latest row is just one
    // re-approved step (t4). A MAX over the run's rows would pick `older`.
    const v3Rows = await baselineRows(v3);
    expect(v3Rows).toHaveLength(1);
    expect(v3Rows[0]).toMatchObject({
      testRunId: newer.runId,
      baselineName: newer.keys[v3],
      userId: approverId,
    });
    // The other steps are untouched: v1 stays on newer, v2 keeps its re-approval.
    expect((await baselineRows(v1)).map((r) => r.id).sort()).toEqual(
      [v1Older, v1Newer].sort(),
    );
    expect((await currentBaseline(v1))!.id).toBe(v1Newer);
    expect((await baselineRows(v2)).map((r) => r.id)).toEqual([v2Older]);
    expect(await repairAuditFor([v1Older, v1Newer, v2Older])).toHaveLength(0);

    // Re-run is a no-op (the repaired v3 row is excluded from acceptance).
    await runMigration();
    expect((await baselineRows(v3)).map((r) => r.id)).toEqual([v3Rows[0]!.id]);
    expect((await baselineRows(v2)).map((r) => r.id)).toEqual([v2Older]);
    expect(await repairAuditFor([v3Rows[0]!.id])).toHaveLength(1);
  });

  it("falls back to the run's updated_at when it owns no baselines row", async () => {
    // A run that owns no baselines row at all (first-baseline without
    // auto-approve): its acceptance time is test_runs.updated_at.
    const stale = await seedVariation("fallback-stale");
    const fresh = await seedVariation("fallback-fresh");

    const staleOther = await seedRun({
      status: "unresolved",
      merge: false,
      createdAt: at(398),
      variationIds: [stale],
    });
    const freshOther = await seedRun({
      status: "unresolved",
      merge: false,
      createdAt: at(398),
      variationIds: [fresh],
    });
    // Both variations have a current baseline from some unrelated run...
    const staleBaseline = await seedBaseline({
      variationId: stale,
      runId: staleOther.runId,
      createdAt: at(401), // ...newer than the approved run was last updated
    });
    const freshBaseline = await seedBaseline({
      variationId: fresh,
      runId: freshOther.runId,
      createdAt: at(399), // ...older than the approved run was last updated
    });
    const approvedStale = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(397),
      updatedAt: at(400),
      variationIds: [stale],
    });
    const approvedFresh = await seedRun({
      status: "passed",
      merge: true,
      createdAt: at(397),
      updatedAt: at(400),
      variationIds: [fresh],
    });

    await runMigration();

    expect((await baselineRows(stale)).map((r) => r.id)).toEqual([
      staleBaseline,
    ]);
    const freshRows = await baselineRows(fresh);
    expect(freshRows).toHaveLength(2);
    expect(freshRows.map((r) => r.id)).toContain(freshBaseline);
    expect((await currentBaseline(fresh))!.test_run_id).toBe(
      approvedFresh.runId,
    );
    void approvedStale;
  });
});
