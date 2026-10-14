import { randomUUID } from "node:crypto";

import {
  builds,
  checkpointDecisions,
  createDb,
  diffRegions,
  eq,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { sweepStaleRuns } from "../src/sweeper.js";

// Wraps the real `recomputeRunStatus` in a spy so the ordering test can see the
// order runs are recomputed in; every other test still runs the real thing.
vi.mock("@furan/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@furan/db")>();
  return {
    ...actual,
    recomputeRunStatus: vi.fn(actual.recomputeRunStatus),
  };
});

const skip = !process.env.DATABASE_URL;
const desc = skip ? describe.skip : describe;

let db: DB;
let closeDb: () => Promise<void>;

// Shared seed: one project + one build + one user.
let projectId: string;
let buildId: string;
let userId: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  closeDb = created.close;

  const uniq = `sw-${Date.now()}`;

  const [u] = await db
    .insert(users)
    .values({
      email: `${uniq}@x.test`,
      hashedPassword: "x",
      firstName: "sw",
      lastName: "tester",
      role: "admin",
    })
    .returning();

  const [p] = await db
    .insert(projects)
    .values({ name: `sweeper-${uniq}`, mainBranchName: "main" })
    .returning();
  projectId = p!.id;
  userId = u!.id;

  const [b] = await db
    .insert(builds)
    .values({ projectId: p!.id, userId: u!.id, isRunning: true })
    .returning();
  buildId = b!.id;
});

afterAll(async () => {
  try {
    if (db && projectId) {
      await db.delete(projects).where(eq(projects.id, projectId));
    }
  } catch {
    /* best-effort cleanup */
  }
  await closeDb();
});

beforeEach(async () => {
  // Remove all test_runs for our project so each test starts clean.
  await db.delete(testRuns).where(eq(testRuns.projectId, projectId));
});

desc("sweepStaleRuns", () => {
  it("finalizes runs with last activity older than the threshold", async () => {
    const now = new Date("2026-05-29T12:00:00Z");
    const stale = new Date("2026-05-29T11:54:00Z"); // 6 min ago

    await db.insert(testRuns).values({
      projectId,
      buildId,
      name: "stale-run",
      branchName: "main",
      status: "running",
      updatedAt: stale,
    });

    const result = await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });
    expect(result.finalized).toBe(1);

    const rows = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId));
    expect(rows[0]?.status).not.toBe("running");
    expect(rows[0]?.completedAt).not.toBeNull();
  });

  it("leaves fresh runs alone", async () => {
    const now = new Date("2026-05-29T12:00:00Z");
    const fresh = new Date("2026-05-29T11:59:00Z"); // 1 min ago

    await db.insert(testRuns).values({
      projectId,
      buildId,
      name: "fresh-run",
      branchName: "main",
      status: "running",
      updatedAt: fresh,
    });

    const result = await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });
    expect(result.finalized).toBe(0);

    const rows = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId));
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.completedAt).toBeNull();
  });

  it("never finalizes already-terminal runs", async () => {
    const now = new Date("2026-05-29T12:00:00Z");
    const stale = new Date("2026-05-29T11:54:00Z"); // 6 min ago

    await db.insert(testRuns).values([
      {
        projectId,
        buildId,
        name: "passed-run",
        branchName: "main",
        status: "passed",
        updatedAt: stale,
      },
      {
        projectId,
        buildId,
        name: "aborted-run",
        branchName: "main",
        status: "aborted",
        updatedAt: stale,
      },
      {
        projectId,
        buildId,
        name: "running-stale-run",
        branchName: "main",
        status: "running",
        updatedAt: stale,
      },
    ]);

    const result = await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });
    expect(result.finalized).toBe(1); // only the running one gets touched

    const runningRows = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId));
    const byName = Object.fromEntries(runningRows.map((r) => [r.name, r]));
    expect(byName["passed-run"]?.status).toBe("passed");
    expect(byName["aborted-run"]?.status).toBe("aborted");
    expect(byName["running-stale-run"]?.status).not.toBe("running");
    expect(byName["running-stale-run"]?.completedAt).not.toBeNull();
  });
});

desc("sweepStaleRuns — per checkpoint on the shared rollup", () => {
  const now = new Date("2026-05-29T12:00:00Z");
  const stale = new Date("2026-05-29T11:54:00Z"); // 6 min ago

  async function seedStaleRun(id?: string): Promise<string> {
    const [r] = await db
      .insert(testRuns)
      .values({
        ...(id ? { id } : {}),
        projectId,
        buildId,
        name: `run-${randomUUID().slice(0, 8)}`,
        branchName: "main",
        status: "running",
        updatedAt: stale,
      })
      .returning({ id: testRuns.id });
    return r!.id;
  }

  /** One checkpoint (own variation) on `runId`; `verdict` null = not diffed. */
  async function seedCheckpoint(
    runId: string,
    name: string,
    verdict: "new" | "passed" | "unresolved" | null,
  ): Promise<string> {
    const [v] = await db
      .insert(testVariations)
      .values({
        name: `${name}-${randomUUID().slice(0, 8)}`,
        projectId,
        branchName: "main",
        browser: "chromium",
        viewport: "400x400",
      })
      .returning({ id: testVariations.id });
    const [s] = await db
      .insert(screenshots)
      .values({
        runId,
        projectId,
        testVariationId: v!.id,
        name,
        imageKey: `img-${randomUUID()}`,
        viewport: "400x400",
        browser: "chromium",
        verdict,
      })
      .returning({ id: screenshots.id });
    return s!.id;
  }

  async function seedRegion(
    runId: string,
    screenshotId: string | null,
    severity: string,
    resolvedByApplicationId: string | null = null,
  ): Promise<void> {
    await db.insert(diffRegions).values({
      runId,
      projectId,
      screenshotId,
      severity,
      category: "visual",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      description: "region",
      source: "l1_pixel",
      viewport: "400x400",
      resolvedByApplicationId,
    });
  }

  async function runRow(runId: string) {
    const [row] = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  async function verdictOf(screenshotId: string) {
    const [row] = await db
      .select({ verdict: screenshots.verdict })
      .from(screenshots)
      .where(eq(screenshots.id, screenshotId));
    return row!.verdict;
  }

  it("turns an undiffed checkpoint with a severity region into unresolved", async () => {
    const runId = await seedStaleRun();
    const shot = await seedCheckpoint(runId, "home", null);
    await seedRegion(runId, shot, "high");

    const result = await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });
    expect(result.finalized).toBe(1);

    expect(await verdictOf(shot)).toBe("unresolved");
    const run = await runRow(runId);
    expect(run.status).toBe("unresolved");
    expect(run.checkpointCount).toBe(1);
    expect(run.completedAt).not.toBeNull();
  });

  it("turns an undiffed checkpoint with no real region into passed", async () => {
    const runId = await seedStaleRun();
    const shot = await seedCheckpoint(runId, "home", null);
    // A severity 'none' audit row (e.g. dynamic-text) does not count.
    await seedRegion(runId, shot, "none");

    await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });

    expect(await verdictOf(shot)).toBe("passed");
    expect((await runRow(runId)).status).toBe("passed");
  });

  it("ignores a region an auto rule resolved, like the backfill", async () => {
    // `resolved_by_application_id` is deliberately not a foreign key (see the
    // diff_regions schema), so any uuid stands in for the winning application.
    const runId = await seedStaleRun();
    const resolved = await seedCheckpoint(runId, "rule-resolved", null);
    await seedRegion(runId, resolved, "high", randomUUID());
    // A second checkpoint with an unresolved severity region still counts.
    const open = await seedCheckpoint(runId, "still-open", null);
    await seedRegion(runId, open, "high");

    await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });

    expect(await verdictOf(resolved)).toBe("passed");
    expect(await verdictOf(open)).toBe("unresolved");
    expect((await runRow(runId)).status).toBe("unresolved");
  });

  it("matches a legacy region without a screenshot id on the run and viewport", async () => {
    const runId = await seedStaleRun();
    const shot = await seedCheckpoint(runId, "legacy", null);
    await seedRegion(runId, null, "medium");

    await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });

    expect(await verdictOf(shot)).toBe("unresolved");
    expect((await runRow(runId)).status).toBe("unresolved");
  });

  it("judges each checkpoint by its own regions, not the run's", async () => {
    const runId = await seedStaleRun();
    const changed = await seedCheckpoint(runId, "changed", null);
    const clean = await seedCheckpoint(runId, "clean", null);
    await seedRegion(runId, changed, "medium");

    await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });

    expect(await verdictOf(changed)).toBe("unresolved");
    expect(await verdictOf(clean)).toBe("passed");
    expect((await runRow(runId)).status).toBe("unresolved");
  });

  it("keeps the verdicts a partly diffed run already has", async () => {
    const runId = await seedStaleRun();
    const isNew = await seedCheckpoint(runId, "first-capture", "new");
    // Already diffed `passed`; a leftover severity region must not flip it.
    const passed = await seedCheckpoint(runId, "diffed-ok", "passed");
    await seedRegion(runId, passed, "high");
    const pending = await seedCheckpoint(runId, "pending", null);

    await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });

    expect(await verdictOf(isNew)).toBe("new");
    expect(await verdictOf(passed)).toBe("passed");
    expect(await verdictOf(pending)).toBe("passed");
    // new outranks passed in the rollup.
    expect((await runRow(runId)).status).toBe("new");
  });

  it("sends a run with no checkpoints to empty", async () => {
    const runId = await seedStaleRun();

    const result = await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });
    expect(result.finalized).toBe(1);

    const run = await runRow(runId);
    expect(run.status).toBe("empty");
    expect(run.checkpointCount).toBe(0);
    expect(run.completedAt).not.toBeNull();
  });

  it("lets an active rejected decision fail the run", async () => {
    const runId = await seedStaleRun();
    const rejected = await seedCheckpoint(runId, "rejected-step", null);
    await seedCheckpoint(runId, "other-step", null);
    await db.insert(checkpointDecisions).values({
      projectId,
      runId,
      screenshotId: rejected,
      actionId: randomUUID(),
      decision: "rejected",
      actorId: userId,
      source: "viewer",
    });

    await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });

    expect((await runRow(runId)).status).toBe("failed");
    // The sweep fills the verdict; the decision stays the reviewer's.
    expect(await verdictOf(rejected)).toBe("passed");
  });

  it("recomputes stale runs in ascending id order", async () => {
    const { recomputeRunStatus } = await import("@furan/db");
    const spy = vi.mocked(recomputeRunStatus);
    // Insert in DESCENDING id order, so a sweep that just follows heap order
    // would visit them descending.
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of [...ids].reverse()) {
      const runId = await seedStaleRun(id);
      await seedCheckpoint(runId, "home", null);
    }
    spy.mockClear();

    const result = await sweepStaleRuns({ db, now, thresholdMs: 5 * 60_000 });
    expect(result.finalized).toBe(4);

    const order = spy.mock.calls.map((call) => call[1]);
    expect(order).toEqual(ids);
  });
});
