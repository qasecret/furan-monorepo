import { randomUUID } from "node:crypto";

import {
  and,
  checkpointDecisions,
  eq,
  inArray,
  screenshots,
  sql,
  testRuns,
  withUserScope,
  type DB,
} from "@furan/db";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { decideCheckpoints } from "../src/lib/review/decide.js";
import { pendingStepCondition } from "../src/lib/review/pending.js";
import { revertAction } from "../src/lib/review/revert.js";
import type { AuthedUser } from "../src/plugins/auth.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewSeed,
  type ReviewUser,
} from "./review-fixtures.js";

/**
 * `screenshots.has_active_decision` (migration 0040, ADR-074): true exactly
 * when the step has an active decision (`checkpoint_decisions.reverted_at IS
 * NULL`), kept so by the trigger on `checkpoint_decisions` and nothing else.
 * These tests drive it through the real decision and undo cores, as the
 * owner and as the app's own connection (the RLS-subject `furan_app` role
 * under TEST_RLS=1).
 */
const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

const logger = { info: vi.fn(), error: vi.fn() };

function actorOf(u: Pick<ReviewUser, "id" | "role">): AuthedUser {
  return { id: u.id, role: u.role, via: "jwt" };
}

d("the active-decision flag on review steps", () => {
  let h: TestApp;
  const seeds: ReviewSeed[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  async function seed(): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, {
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "new" },
      ],
    });
    seeds.push(s);
    return s;
  }

  const deps = () => ({ registry: h.telemetry.metrics, logger });

  /** Each step's flag, read as the owner (so RLS never hides a row). */
  async function flags(s: ReviewSeed): Promise<Record<string, boolean>> {
    const rows = await h.db.execute<{ id: string; flag: boolean }>(
      sql`select id, has_active_decision as flag from screenshots where run_id = ${s.runId}`,
    );
    const byId = new Map(rows.map((r) => [r.id, r.flag]));
    return Object.fromEntries(
      Object.entries(s.shots).map(([name, shot]) => [name, byId.get(shot.id)]),
    );
  }

  /** The run's steps `pendingStepCondition` selects, by name. */
  async function pendingNames(s: ReviewSeed): Promise<string[]> {
    const rows = await h.db
      .select({ id: screenshots.id })
      .from(screenshots)
      .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
      .where(and(eq(testRuns.id, s.runId), pendingStepCondition()));
    const ids = new Set(rows.map((r) => r.id));
    return Object.entries(s.shots)
      .filter(([, shot]) => ids.has(shot.id))
      .map(([name]) => name)
      .sort();
  }

  /** Decides `names` of the seed's run through the core, on `db`. */
  function decide(
    db: DB,
    s: ReviewSeed,
    decision: "approved" | "rejected",
    names: string[],
  ): Promise<string> {
    const actionId = randomUUID();
    return withUserScope(
      db,
      { userId: s.editor.id, role: "editor", projectId: s.projectId },
      (tx) =>
        decideCheckpoints(
          tx,
          {
            actor: actorOf(s.editor),
            projectId: s.projectId,
            actionId,
            source: "viewer",
            decision,
            targets: names.map((n) => ({
              runId: s.runId,
              screenshotId: s.shots[n]!.id,
            })),
          },
          deps(),
        ),
    ).then(() => actionId);
  }

  /** Undoes `actionId` through the core, on `db`. */
  async function revert(
    db: DB,
    s: ReviewSeed,
    actionId: string,
  ): Promise<void> {
    const res = await withUserScope(
      db,
      { userId: s.editor.id, role: "editor", projectId: s.projectId },
      (tx) =>
        revertAction(
          tx,
          { actor: actorOf(s.editor), actionId, projectId: s.projectId },
          deps(),
        ),
    );
    expect(res.skipped).toEqual([]);
  }

  /** decide → revert → re-decide on `db`, checking the flag after each. */
  async function walk(db: DB, s: ReviewSeed): Promise<void> {
    expect(await flags(s)).toEqual({ a: false, b: false });
    expect(await pendingNames(s)).toEqual(["a", "b"]);

    const approveA = await decide(db, s, "approved", ["a"]);
    expect(await flags(s)).toEqual({ a: true, b: false });
    expect(await pendingNames(s)).toEqual(["b"]);

    const rejectB = await decide(db, s, "rejected", ["b"]);
    expect(await flags(s)).toEqual({ a: true, b: true });
    expect(await pendingNames(s)).toEqual([]);

    await revert(db, s, approveA);
    expect(await flags(s)).toEqual({ a: false, b: true });
    expect(await pendingNames(s)).toEqual(["a"]);

    // Re-decided: a new active row beside the reverted one.
    await decide(db, s, "rejected", ["a"]);
    expect(await flags(s)).toEqual({ a: true, b: true });

    await revert(db, s, rejectB);
    expect(await flags(s)).toEqual({ a: true, b: false });
    expect(await pendingNames(s)).toEqual(["b"]);
  }

  test("the flag follows decide, revert and re-decide", async () => {
    const s = await seed();
    await walk(h.db, s);
  });

  test("under TEST_RLS the trigger updates the flag as the app role", async () => {
    const s = await seed();
    const app = h.app.db;
    const [who] = await withUserScope(
      app,
      { userId: s.editor.id, role: "editor", projectId: s.projectId },
      (tx) => tx.execute<{ role: string }>(sql`select current_user as role`),
    );
    if (process.env.TEST_RLS === "1") expect(who!.role).toBe("furan_app");

    await walk(app, s);

    // A run deleted as the app role: its decisions cascade away with its
    // steps, and the trigger tolerates the steps already being gone.
    await withUserScope(
      app,
      { userId: s.editor.id, role: "editor", projectId: s.projectId },
      (tx) => tx.delete(testRuns).where(eq(testRuns.id, s.runId)),
    );
    const shotIds = Object.values(s.shots).map((x) => x.id);
    expect(
      await h.db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(inArray(screenshots.id, shotIds)),
    ).toEqual([]);
    expect(
      await h.db
        .select({ id: checkpointDecisions.id })
        .from(checkpointDecisions)
        .where(inArray(checkpointDecisions.screenshotId, shotIds)),
    ).toEqual([]);
  });
});
