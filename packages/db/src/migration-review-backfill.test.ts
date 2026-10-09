import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { rollupRunStatus } from "@furan/shared-types";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  baselines,
  builds,
  checkpointDecisions,
  createDb,
  eq,
  inArray,
  loadRollupInputs,
  or,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
  type RunStatus,
} from "./index.js";

/**
 * Migration `0037_review_backfill` (review-flow spec §4.5).
 *
 * Installs that predate the review model hold runs reviewed under the old
 * run-level model: their screenshots carry no `verdict` and their reviews left
 * no `checkpoint_decisions` row. The backfill derives both, and must leave
 * every run's status exactly what it is today under the new rollup. It writes
 * no status: parity is proven here, per run class, and on a live database by
 * the `verify-review-rollup` CLI.
 *
 * Like the other data-migration tests, this seeds legacy-shaped rows on the
 * already-migrated database, executes the migration file from disk and
 * asserts. The file is global, so everything is scoped to this test's own
 * project, runs and users.
 *
 * Skipped when `DATABASE_URL` is unset — same convention as the other
 * migration tests in this package.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0037_review_backfill.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

const HOUR = 3_600_000;
const DESKTOP = "1280x720";
const MOBILE = "375x667";

type Verdict = "new" | "passed" | "unresolved";
type Kind = "approved" | "rejected";

interface ShotSpec {
  name: string;
  viewport?: string;
  /** A verdict the new diff pipeline already wrote; default NULL (legacy). */
  verdict?: Verdict;
}

interface Seeded {
  runId: string;
  /** checkpoint name → screenshot id */
  shot: Record<string, string>;
  /** checkpoint name → variation id */
  variation: Record<string, string>;
  updatedAt: Date;
}

/**
 * One legacy run class (spec §4.5 step 3): what is stored today, and what the
 * backfill must derive for it. `actor` is the expected `actor_id` of the
 * class's legacy decisions, resolved after seeding.
 */
interface RunClass {
  name: string;
  status: RunStatus;
  merge?: boolean;
  shots: ShotSpec[];
  /** Class-specific rows (regions, baselines, audit entries). */
  setup?: (run: Seeded) => Promise<void>;
  /** Expected verdict per checkpoint after the backfill (null = untouched). */
  verdicts: Record<string, Verdict | null>;
  /** Expected legacy decision per checkpoint (absent = none). */
  decisions: Record<string, Kind>;
  actor?: () => string | null;
}

describe.runIf(RUN_INTEGRATION)("0037_review_backfill migration", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID().slice(0, 8);
  /** Fixed past origin; every run gets its own distinct `updated_at`. */
  const T0 = Date.now() - 900 * HOUR;
  let hourCursor = 0;
  const nextTime = (): Date => new Date(T0 + ++hourCursor * HOUR);

  let projectId: string;
  let buildId: string;
  const userIds: string[] = [];
  const runIds: string[] = [];
  const u: Record<
    "approverA" | "approverB" | "rejecterOld" | "rejecterNew" | "bystander",
    string
  > = {
    approverA: "",
    approverB: "",
    rejecterOld: "",
    rejecterNew: "",
    bystander: "",
  };

  // --- seed helpers ---------------------------------------------------------

  async function seedUser(label: string): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `review-backfill-${label}-${tag}@t.example`,
        hashedPassword: "x",
        firstName: label,
        lastName: "backfill",
        role: "editor",
      })
      .returning({ id: users.id });
    userIds.push(row!.id);
    return row!.id;
  }

  async function seedRun(opts: {
    label: string;
    status: RunStatus;
    merge?: boolean | undefined;
    override?: "passed" | "failed" | null;
    shots: ShotSpec[];
  }): Promise<Seeded> {
    const updatedAt = nextTime();
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `${opts.label}-${tag}`,
        status: opts.status,
        merge: opts.merge ?? false,
        statusOverride: opts.override ?? null,
        branchName: "main",
        createdAt: new Date(updatedAt.getTime() - HOUR / 2),
        updatedAt,
      })
      .returning({ id: testRuns.id });
    const runId = r!.id;
    runIds.push(runId);
    const seeded: Seeded = { runId, shot: {}, variation: {}, updatedAt };
    for (const s of opts.shots) {
      const viewport = s.viewport ?? DESKTOP;
      const [v] = await db
        .insert(testVariations)
        .values({
          projectId,
          name: `${opts.label}-${s.name}-${tag}`,
          branchName: "main",
          viewport,
        })
        .returning({ id: testVariations.id });
      const [shot] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: v!.id,
          name: s.name,
          viewport,
          browser: "chromium",
          imageKey: `img-${randomUUID()}`,
          verdict: s.verdict ?? null,
          verdictAt: s.verdict ? new Date(updatedAt.getTime() - 1) : null,
          createdAt: new Date(updatedAt.getTime() - HOUR / 4),
        })
        .returning({ id: screenshots.id });
      seeded.shot[s.name] = shot!.id;
      seeded.variation[s.name] = v!.id;
    }
    return seeded;
  }

  /**
   * A diff region. `on` is the checkpoint it was detected on (by
   * `screenshot_id`, as v1.1.20+ writes it); `legacyViewport` seeds a
   * pre-v1.1.20 row with NULL `screenshot_id` that matches on run + viewport
   * (`null` = a v0.4 row with no viewport either).
   */
  async function seedRegion(
    run: Seeded,
    where: { on: string } | { legacyViewport: string | null },
    opts: { severity?: string; ruleResolved?: boolean } = {},
  ): Promise<void> {
    const onShot = "on" in where;
    await db.execute(sql`
      INSERT INTO diff_regions
        (run_id, project_id, screenshot_id, severity, category, bbox,
         description, source, viewport, resolved_by_application_id)
      VALUES (
        ${run.runId}, ${projectId},
        ${onShot ? run.shot[where.on]! : null},
        ${opts.severity ?? "major"}, 'visual',
        ${JSON.stringify({ x: 0, y: 0, w: 10, h: 10 })}::jsonb,
        'seeded', 'pixel',
        ${onShot ? DESKTOP : where.legacyViewport},
        ${opts.ruleResolved ? randomUUID() : null}
      )
    `);
  }

  async function seedBaseline(
    run: Seeded,
    checkpoint: string,
    userId: string | null,
  ): Promise<void> {
    await db.insert(baselines).values({
      testVariationId: run.variation[checkpoint]!,
      testRunId: run.runId,
      userId,
      branchName: "main",
      baselineName: `bl-${randomUUID()}`,
    });
  }

  async function seedAudit(opts: {
    action: string;
    targetId: string;
    actorId: string | null;
    createdAt: Date;
    targetType?: string;
    id?: string;
  }): Promise<void> {
    await db.insert(auditLog).values({
      ...(opts.id ? { id: opts.id } : {}),
      actorId: opts.actorId,
      action: opts.action,
      targetType: opts.targetType ?? "run",
      targetId: opts.targetId,
      metadata: {},
      createdAt: opts.createdAt,
    });
  }

  /** Execute the migration file as drizzle's migrator does: split on the
   *  breakpoint marker, execute each statement, in one transaction. The
   *  migration's RAISE NOTICE is kept off the test output (the driver logs
   *  every notice it receives). */
  async function runMigration(): Promise<void> {
    const statements = MIGRATION_SQL.split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      for (const stmt of statements) {
        await tx.execute(sql.raw(stmt));
      }
    });
  }

  // --- the legacy run classes (spec §4.5) -------------------------------------

  /** Two `run.reject` rows at the same instant: the larger id wins the tie. */
  const tie = [randomUUID(), randomUUID()].sort();
  const tieLow = tie[0]!;
  const tieHigh = tie[1]!;
  const deletedUserId = randomUUID();

  const CLASSES: RunClass[] = [
    {
      name: "machine-passed",
      status: "passed",
      shots: [{ name: "home" }, { name: "cart" }],
      // A region whose severity is 'none' never counts.
      setup: (r) => seedRegion(r, { on: "home" }, { severity: "none" }),
      verdicts: { home: "passed", cart: "passed" },
      decisions: {},
    },
    {
      // R22: passed by the diff and never promoted (merge = false). Regions
      // below the diff threshold do not make it unresolved: the per-checkpoint
      // worker would have judged every step `passed`. Recording a synthetic
      // approval instead would mask a later re-diff of the step.
      name: "machine-passed with sub-threshold regions",
      status: "passed",
      merge: false,
      shots: [{ name: "a" }, { name: "b" }, { name: "c", viewport: MOBILE }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" }, { severity: "minor" });
        await seedRegion(r, { legacyViewport: MOBILE }, { severity: "minor" });
      },
      verdicts: { a: "passed", b: "passed", c: "passed" },
      decisions: {},
    },
    {
      name: "approved single",
      status: "passed",
      merge: true,
      shots: [{ name: "home" }],
      setup: async (r) => {
        await seedRegion(r, { on: "home" });
        await seedBaseline(r, "home", u.approverB);
      },
      verdicts: { home: "unresolved" },
      decisions: { home: "approved" },
      actor: () => u.approverB,
    },
    {
      name: "approved multi",
      status: "passed",
      merge: true,
      shots: [{ name: "a" }, { name: "b" }, { name: "c", viewport: MOBILE }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" });
        // Legacy pre-v1.1.20 row: NULL screenshot_id, matched by viewport.
        await seedRegion(r, { legacyViewport: MOBILE });
        // Two approvers on the run (e.g. 0036 repaired one): MIN(user_id).
        await seedBaseline(r, "a", u.approverB);
        await seedBaseline(r, "b", u.approverA);
        await seedBaseline(r, "c", null);
      },
      verdicts: { a: "unresolved", b: "passed", c: "unresolved" },
      decisions: { a: "approved", c: "approved" },
      actor: () => [u.approverA, u.approverB].sort()[0]!,
    },
    {
      name: "rejected",
      status: "failed",
      shots: [{ name: "a" }, { name: "b" }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" });
        const t = r.updatedAt.getTime();
        await seedAudit({
          action: "run.reject",
          targetId: r.runId,
          actorId: u.rejecterOld,
          createdAt: new Date(t - 3000),
        });
        await seedAudit({
          action: "run.reviewer_reject",
          targetId: r.runId,
          actorId: u.rejecterNew,
          createdAt: new Date(t - 2000),
        });
        // Newer, but not a reject: ignored.
        await seedAudit({
          action: "run.override_status",
          targetId: r.runId,
          actorId: u.bystander,
          createdAt: new Date(t - 1000),
        });
      },
      verdicts: { a: "unresolved", b: "passed" },
      decisions: { a: "rejected" },
      actor: () => u.rejecterNew,
    },
    {
      name: "rejected (created_at tie)",
      status: "failed",
      shots: [{ name: "a" }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" });
        const at = new Date(r.updatedAt.getTime() - 1000);
        await seedAudit({
          id: tieLow,
          action: "run.reject",
          targetId: r.runId,
          actorId: u.rejecterNew,
          createdAt: at,
        });
        await seedAudit({
          id: tieHigh,
          action: "run.reject",
          targetId: r.runId,
          actorId: u.rejecterOld,
          createdAt: at,
        });
      },
      verdicts: { a: "unresolved" },
      decisions: { a: "rejected" },
      actor: () => u.rejecterOld,
    },
    {
      name: "rejected by a since-deleted user",
      status: "failed",
      shots: [{ name: "a" }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" });
        const t = r.updatedAt.getTime();
        await seedAudit({
          action: "run.reject",
          targetId: r.runId,
          actorId: u.rejecterOld,
          createdAt: new Date(t - 2000),
        });
        // The newest reject's actor no longer exists (audit_log has no FK):
        // NULL, as the FK's ON DELETE SET NULL would have left it — never the
        // older rejecter.
        await seedAudit({
          action: "run.reject",
          targetId: r.runId,
          actorId: deletedUserId,
          createdAt: new Date(t - 1000),
        });
      },
      verdicts: { a: "unresolved" },
      decisions: { a: "rejected" },
      actor: () => null,
    },
    {
      name: "rejected via inbox cluster",
      status: "failed",
      shots: [{ name: "a" }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" });
        // The legacy cluster reject audited the PROJECT, not the run.
        await seedAudit({
          action: "run.reject_cluster",
          targetType: "project",
          targetId: projectId,
          actorId: u.rejecterOld,
          createdAt: new Date(r.updatedAt.getTime() - 1000),
        });
      },
      verdicts: { a: "unresolved" },
      decisions: { a: "rejected" },
      actor: () => null,
    },
    {
      name: "force-failed",
      status: "failed",
      shots: [{ name: "a" }, { name: "b" }],
      // No region anywhere: every checkpoint is rejected.
      verdicts: { a: "passed", b: "passed" },
      decisions: { a: "rejected", b: "rejected" },
      actor: () => null,
    },
    {
      name: "unresolved with regions",
      status: "unresolved",
      shots: [{ name: "a" }, { name: "b" }, { name: "c" }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" });
        await seedRegion(r, { on: "b" }, { ruleResolved: true });
        await seedRegion(r, { on: "c" }, { severity: "none" });
      },
      verdicts: { a: "unresolved", b: "passed", c: "passed" },
      decisions: {},
    },
    {
      name: "unresolved without regions",
      status: "unresolved",
      shots: [{ name: "a" }, { name: "b" }],
      setup: async (r) => {
        // Qualifying regions that match NO checkpoint: a legacy row at a
        // viewport the run has no screenshot of, and a v0.4 row with neither
        // screenshot nor viewport. "No qualifying region on any checkpoint".
        await seedRegion(r, { legacyViewport: "9x9" });
        await seedRegion(r, { legacyViewport: null });
      },
      verdicts: { a: "unresolved", b: "unresolved" },
      decisions: {},
    },
    {
      name: "new",
      status: "new",
      merge: true,
      shots: [{ name: "a" }, { name: "b" }],
      verdicts: { a: "new", b: "new" },
      decisions: {},
    },
    {
      name: "rule-resolved",
      status: "passed",
      shots: [{ name: "a" }, { name: "b" }],
      setup: async (r) => {
        await seedRegion(r, { on: "a" }, { ruleResolved: true });
        await seedRegion(r, { on: "b" }, { ruleResolved: true });
      },
      verdicts: { a: "passed", b: "passed" },
      decisions: {},
    },
    {
      name: "running",
      status: "running",
      shots: [{ name: "a" }, { name: "b" }],
      setup: (r) => seedRegion(r, { on: "a" }),
      verdicts: { a: null, b: null },
      decisions: {},
    },
    {
      name: "aborted",
      status: "aborted",
      shots: [{ name: "a" }],
      setup: (r) => seedRegion(r, { on: "a" }),
      verdicts: { a: null },
      decisions: {},
    },
    {
      name: "empty",
      status: "empty",
      shots: [],
      verdicts: {},
      decisions: {},
    },
    {
      name: "passed with no checkpoints",
      status: "passed",
      merge: true,
      shots: [],
      verdicts: {},
      decisions: {},
    },
  ];

  const seededByClass = new Map<string, Seeded>();
  const classRunIds = (): string[] =>
    [...seededByClass.values()].map((s) => s.runId);

  // --- snapshots ------------------------------------------------------------

  async function runRows(ids: string[]) {
    return db
      .select({
        id: testRuns.id,
        status: testRuns.status,
        merge: testRuns.merge,
        override: testRuns.statusOverride,
        updatedAt: sql<string>`${testRuns.updatedAt}::text`,
      })
      .from(testRuns)
      .where(inArray(testRuns.id, ids))
      .orderBy(testRuns.id);
  }

  async function shotRows(ids: string[]) {
    return db
      .select({
        id: screenshots.id,
        runId: screenshots.runId,
        verdict: screenshots.verdict,
        verdictAt: sql<string | null>`${screenshots.verdictAt}::text`,
      })
      .from(screenshots)
      .where(inArray(screenshots.runId, ids))
      .orderBy(screenshots.id);
  }

  async function decisionRows(ids: string[]) {
    return db
      .select({
        id: checkpointDecisions.id,
        projectId: checkpointDecisions.projectId,
        runId: checkpointDecisions.runId,
        screenshotId: checkpointDecisions.screenshotId,
        actionId: checkpointDecisions.actionId,
        decision: checkpointDecisions.decision,
        actorId: checkpointDecisions.actorId,
        source: checkpointDecisions.source,
        before: checkpointDecisions.before,
        createdAt: sql<string>`${checkpointDecisions.createdAt}::text`,
        revertedAt: checkpointDecisions.revertedAt,
        revertedBy: checkpointDecisions.revertedBy,
      })
      .from(checkpointDecisions)
      .where(inArray(checkpointDecisions.runId, ids))
      .orderBy(checkpointDecisions.id);
  }

  let runsBefore: Awaited<ReturnType<typeof runRows>>;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;

    u.approverA = await seedUser("approver-a");
    u.approverB = await seedUser("approver-b");
    u.rejecterOld = await seedUser("rejecter-old");
    u.rejecterNew = await seedUser("rejecter-new");
    u.bystander = await seedUser("bystander");

    const [p] = await db
      .insert(projects)
      .values({ name: `review-backfill-${tag}` })
      .returning({ id: projects.id });
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, isRunning: false })
      .returning({ id: builds.id });
    buildId = b!.id;

    for (const c of CLASSES) {
      const run = await seedRun({
        label: c.name.replace(/\W+/g, "-"),
        status: c.status,
        merge: c.merge,
        shots: c.shots,
      });
      await c.setup?.(run);
      seededByClass.set(c.name, run);
    }

    runsBefore = await runRows(classRunIds());
    await runMigration();
  });

  afterAll(async () => {
    // audit_log has no FKs: remove what this file wrote by target.
    if (runIds.length > 0 || projectId) {
      await db
        .delete(auditLog)
        .where(
          or(
            inArray(auditLog.targetId, runIds),
            eq(auditLog.targetId, projectId),
          ),
        );
    }
    // projects cascade to builds / runs / screenshots / variations /
    // diff_regions / baselines / checkpoint_decisions.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await close();
  });

  // --- the migration file ---------------------------------------------------

  it("is a single DO block that writes 'backfill' decisions and no status", () => {
    const body = MIGRATION_SQL.replace(/--.*$/gm, "").trim();
    expect(body).toMatch(/^DO \$\$/);
    expect(body).not.toMatch(/statement-breakpoint/);
    expect(body).toMatch(/'backfill'/);
    // No statement writes test_runs (parity is proven, not forced).
    expect(body).not.toMatch(/UPDATE\s+"?test_runs"?/i);
  });

  // --- parity: rollup(after) === status(before), per class ------------------

  it.each(CLASSES.map((c) => [c.name, c] as const))(
    "parity: %s keeps its stored status under the rollup",
    async (_name, c) => {
      const run = seededByClass.get(c.name)!;
      const input = (await loadRollupInputs(db, [run.runId])).get(run.runId);
      expect(input).toBeDefined();
      expect(input!.lifecycle).toBe(c.status);
      expect(rollupRunStatus(input!)).toBe(c.status);
    },
  );

  it("derives each checkpoint's verdict (sweeper predicate, then the run's status), stamped at the run's updated_at", async () => {
    for (const c of CLASSES) {
      const run = seededByClass.get(c.name)!;
      const rows = await shotRows([run.runId]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const [name, expected] of Object.entries(c.verdicts)) {
        const row = byId.get(run.shot[name]!)!;
        expect({ class: c.name, name, verdict: row.verdict }).toEqual({
          class: c.name,
          name,
          verdict: expected,
        });
      }
    }
    // verdict_at = run.updated_at, exactly (microseconds included).
    const [stamped] = await db.execute<{ off: number; total: number }>(sql`
      SELECT
        count(*) FILTER (WHERE s.verdict_at IS DISTINCT FROM r.updated_at)::int AS off,
        count(*)::int AS total
      FROM screenshots s JOIN test_runs r ON r.id = s.run_id
      WHERE r.project_id = ${projectId} AND s.verdict IS NOT NULL
    `);
    expect(stamped!.total).toBeGreaterThan(0);
    expect(stamped!.off).toBe(0);
  });

  it("records a legacy decision per non-passed checkpoint of passed runs (approved) and failed runs (rejected; every checkpoint when all passed)", async () => {
    for (const c of CLASSES) {
      const run = seededByClass.get(c.name)!;
      const rows = await decisionRows([run.runId]);
      const nameOf = new Map(
        Object.entries(run.shot).map(([name, id]) => [id, name]),
      );
      const got = Object.fromEntries(
        rows.map((r) => [nameOf.get(r.screenshotId)!, r.decision]),
      );
      expect({ class: c.name, decisions: got }).toEqual({
        class: c.name,
        decisions: c.decisions,
      });
    }
  });

  it("legacy decisions are non-undoable 'backfill' rows: one action per run, the run's project and updated_at, not reverted", async () => {
    const rows = await decisionRows(classRunIds());
    expect(rows.length).toBeGreaterThan(0);
    const runUpdatedAt = new Map(
      runsBefore.map((r) => [r.id, r.updatedAt] as const),
    );
    for (const r of rows) {
      expect(r.source).toBe("backfill");
      expect(r.before).toBeNull();
      expect(r.revertedAt).toBeNull();
      expect(r.revertedBy).toBeNull();
      expect(r.projectId).toBe(projectId);
      expect(r.createdAt).toBe(runUpdatedAt.get(r.runId));
    }
    // Every decision carries its screenshot's run.
    const shots = await shotRows(classRunIds());
    const runOfShot = new Map(shots.map((s) => [s.id, s.runId]));
    for (const r of rows) expect(runOfShot.get(r.screenshotId)).toBe(r.runId);

    // One action_id per run, distinct across runs.
    const actionsByRun = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = actionsByRun.get(r.runId) ?? new Set();
      set.add(r.actionId);
      actionsByRun.set(r.runId, set);
    }
    for (const set of actionsByRun.values()) expect(set.size).toBe(1);
    const allActions = [...actionsByRun.values()].map((s) => [...s][0]);
    expect(new Set(allActions).size).toBe(actionsByRun.size);
    expect(actionsByRun.size).toBeGreaterThanOrEqual(2);
  });

  it("legacy actors: the run's approver (MIN baselines.user_id) or its newest reject's existing actor, else NULL", async () => {
    for (const c of CLASSES) {
      if (Object.keys(c.decisions).length === 0) continue;
      const run = seededByClass.get(c.name)!;
      const rows = await decisionRows([run.runId]);
      expect(rows).toHaveLength(Object.keys(c.decisions).length);
      const expected = c.actor ? c.actor() : null;
      for (const r of rows) {
        expect({ class: c.name, actor: r.actorId }).toEqual({
          class: c.name,
          actor: expected,
        });
      }
    }
  });

  it("writes no run status: test_runs is untouched", async () => {
    expect(await runRows(classRunIds())).toEqual(runsBefore);
  });

  it("is idempotent: further executions change no verdict, verdict_at or decision", async () => {
    const ids = classRunIds();
    const before = {
      runs: await runRows(ids),
      shots: await shotRows(ids),
      decisions: await decisionRows(ids),
    };
    expect(before.decisions.length).toBeGreaterThan(0);

    await runMigration();
    await runMigration();

    expect({
      runs: await runRows(ids),
      shots: await shotRows(ids),
      decisions: await decisionRows(ids),
    }).toEqual(before);
  });

  it("re-applied over review-model data, it fills no gap the new model left on purpose", async () => {
    // (a) An overridden run whose re-diff is pending: the override wins the
    //     rollup, the NULL verdict is the diff-worker's to write.
    const overridden = await seedRun({
      label: "overridden-pending",
      status: "passed",
      override: "passed",
      shots: [{ name: "a" }],
    });
    await seedRegion(overridden, { on: "a" });

    // (a') A run "Force failed" under the new model (status_override): its
    //      pending step must stay pending, so "Reset to computed" brings
    //      back the rollup of the checkpoints, not a backfilled rejection.
    const forced = await seedRun({
      label: "force-failed-override",
      status: "failed",
      override: "failed",
      shots: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "passed" },
      ],
    });

    // (b) A failed run decided under the new model: one step rejected, the
    //     other left pending. The backfill must not reject the pending one.
    const decided = await seedRun({
      label: "decided-failed",
      status: "failed",
      shots: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "unresolved" },
      ],
    });
    const actionId = randomUUID();
    await db.insert(checkpointDecisions).values({
      projectId,
      runId: decided.runId,
      screenshotId: decided.shot.a!,
      actionId,
      decision: "rejected",
      actorId: u.rejecterNew,
      source: "viewer",
      before: { baseline: null, variation: null },
    });

    // (c) A screenshot that already carries a decision gets no other, even
    //     when that decision is filed under another run (corrupt data the
    //     run-level guard cannot see): a second active decision would break
    //     the partial unique index and fail the whole migration.
    const misfiled = await seedRun({
      label: "misfiled-decision",
      status: "failed",
      shots: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "passed" },
      ],
    });
    await db.insert(checkpointDecisions).values({
      projectId,
      runId: overridden.runId,
      screenshotId: misfiled.shot.a!,
      actionId: randomUUID(),
      decision: "rejected",
      actorId: null,
      source: "viewer",
      before: { baseline: null, variation: null },
    });

    const ids = [overridden.runId, forced.runId, decided.runId, misfiled.runId];
    const before = {
      runs: await runRows(ids),
      shots: await shotRows(ids),
      decisions: await decisionRows(ids),
    };
    expect(before.decisions).toHaveLength(2);

    await runMigration();

    expect({
      runs: await runRows(ids),
      shots: await shotRows(ids),
      decisions: await decisionRows(ids),
    }).toEqual(before);
  });

  it("never overwrites a verdict that is already set, even where the legacy rule would derive another", async () => {
    // A run in scope (one checkpoint still NULL) whose other checkpoint the
    // diff-worker already judged 'passed' despite a qualifying region.
    const mixed = await seedRun({
      label: "mixed",
      status: "unresolved",
      shots: [{ name: "a", verdict: "passed" }, { name: "b" }],
    });
    await seedRegion(mixed, { on: "a" });
    await seedRegion(mixed, { on: "b" });
    const [aBefore] = await shotRows([mixed.runId]).then((rows) =>
      rows.filter((r) => r.id === mixed.shot.a),
    );

    await runMigration();

    const rows = await shotRows([mixed.runId]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(mixed.shot.a!)).toEqual(aBefore);
    expect(byId.get(mixed.shot.b!)!.verdict).toBe("unresolved");
  });
});
