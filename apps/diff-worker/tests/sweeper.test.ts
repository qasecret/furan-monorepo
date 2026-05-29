import {
  builds,
  createDb,
  eq,
  projects,
  testRuns,
  users,
  type DB,
} from "@furan/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sweepStaleRuns } from "../src/sweeper.js";

const skip = !process.env.DATABASE_URL;
const desc = skip ? describe.skip : describe;

let db: DB;
let closeDb: () => Promise<void>;

// Shared seed: one project + one build + one user.
let projectId: string;
let buildId: string;

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
