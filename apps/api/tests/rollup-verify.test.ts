import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditLog,
  checkpointDecisions,
  COUNTERS_BACKFILL_SQL,
  createDb,
  diffRegions,
  eq,
  inArray,
  recomputeRunStatus,
  sql,
  testRuns,
  type RunCounters,
} from "@furan/db";
import type { RunStatus } from "@furan/shared-types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  findRollupMismatches,
  listBaselineRepairs,
  repairRunCounters,
  type RollupMismatch,
} from "../src/lib/review/rollup-verify.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * `findRollupMismatches` backs the `verify-review-rollup` CLI (spec §4.6):
 * for every finished run it recomputes `rollupRunStatus` from the stored
 * verdicts, active decisions and override, and reports each run whose stored
 * status differs; for every run it also checks the stored pending counters
 * against their definition (spec 2026-10-27 §3.3). `repairRunCounters` backs
 * its `--repair-counters` flag, `listBaselineRepairs` its `--repairs` flag.
 *
 * Everything is asserted on this file's own seeds (the functions also scan
 * whatever else the shared test database holds). The seeds start with
 * consistent counters (`review-fixtures.ts`).
 */
const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

const BACKFILL_SQL = skip
  ? ""
  : readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../packages/db/migrations/0037_review_backfill.sql",
      ),
      "utf8",
    );

/** Postgres orders uuids by their bytes, i.e. their lowercase hex text. */
const byRunId = (a: { runId: string }, b: { runId: string }) =>
  a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;

/** `pending/failed`, for a `RunCounters`. */
const c = (pendingSteps: number, failedSteps = 0): RunCounters => ({
  pendingSteps,
  failedSteps,
});

/**
 * One expected mismatch. `counters` is the stored pair, then the computed one;
 * a run listed for its status alone has the same pair on both sides.
 */
function mismatch(
  runId: string,
  stored: RunStatus,
  computed: RunStatus,
  counters: [RunCounters, RunCounters] | RunCounters = c(0),
): RollupMismatch {
  const [storedCounters, computedCounters] = Array.isArray(counters)
    ? counters
    : [counters, counters];
  return { runId, stored, computed, storedCounters, computedCounters };
}

d("findRollupMismatches", () => {
  let h: TestApp;
  const seeds: ReviewSeed[] = [];
  const repairAuditIds: string[] = [];

  beforeAll(async () => {
    h = await createTestApp();
  });

  afterAll(async () => {
    if (repairAuditIds.length > 0) {
      await h.db.delete(auditLog).where(inArray(auditLog.id, repairAuditIds));
    }
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  async function seed(...args: Parameters<typeof seedReviewRun>) {
    const s = await seedReviewRun(...args);
    seeds.push(s);
    return s;
  }

  async function setStatus(runId: string, status: "passed" | "failed") {
    await h.db.update(testRuns).set({ status }).where(eq(testRuns.id, runId));
  }

  async function setCounters(runId: string, counters: RunCounters) {
    await h.db.update(testRuns).set(counters).where(eq(testRuns.id, runId));
  }

  async function storedRun(runId: string) {
    const [row] = await h.db
      .select({
        status: testRuns.status,
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  test("reports nothing when every stored status is its rollup", async () => {
    const s = await seed(h, {
      checkpoints: [
        { name: "a", verdict: "passed" },
        { name: "b", verdict: "unresolved" },
      ],
    });
    await addReviewRun(h, s, { checkpoints: [{ name: "c", verdict: "new" }] });
    await addReviewRun(h, s, {
      checkpoints: [{ name: "d", verdict: "unresolved" }],
      override: "passed",
    });
    await addReviewRun(h, s, {
      checkpoints: [{ name: "e", verdict: null }],
      lifecycle: "aborted",
    });

    expect(
      await findRollupMismatches(h.db, { projectId: s.projectId }),
    ).toEqual([]);
  });

  test("flags pre-backfill legacy runs, and none once 0037 has run", async () => {
    // Legacy shape: no verdicts, no decisions, the run-level status of the
    // old review model.
    const s = await seed(h, {
      checkpoints: [
        { name: "home", verdict: null },
        { name: "cart", verdict: null },
      ],
      lifecycle: "passed",
    });
    const rejected = await addReviewRun(h, s, {
      checkpoints: [{ name: "checkout", verdict: null }],
      lifecycle: "failed",
    });
    const unresolved = await addReviewRun(h, s, {
      checkpoints: [
        { name: "search", verdict: null },
        { name: "profile", verdict: null },
      ],
      lifecycle: "unresolved",
    });
    await h.db.insert(diffRegions).values({
      runId: unresolved.runId,
      projectId: s.projectId,
      screenshotId: unresolved.shots.search!.id,
      severity: "major",
      category: "visual",
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      description: "seeded",
      source: "pixel",
      viewport: "1280x720",
    });

    const before = await findRollupMismatches(h.db, {
      projectId: s.projectId,
    });
    expect(before).toEqual(
      [
        mismatch(s.runId, "passed", "running"),
        mismatch(rejected.runId, "failed", "running"),
        mismatch(unresolved.runId, "unresolved", "running"),
      ].sort(byRunId),
    );

    await h.db.transaction(async (tx) => {
      // Keep the migration's RAISE NOTICE off the test output.
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql.raw(BACKFILL_SQL));
      // 0043's backfill runs after 0037 in an upgrade: the verdicts 0037
      // derives give the unresolved run a pending step to count.
      await tx.execute(sql.raw(COUNTERS_BACKFILL_SQL));
    });

    expect(
      await findRollupMismatches(h.db, { projectId: s.projectId }),
    ).toEqual([]);
  });

  test("flags a hand-corrupted status with what the rollup computes", async () => {
    const s = await seed(h, {
      checkpoints: [
        { name: "a", verdict: "passed" },
        { name: "b", verdict: "unresolved" },
      ],
    });
    await setStatus(s.runId, "passed");

    // The counters are judged by the stored status: `passed` is reviewable,
    // so the stored 1 pending step is right.
    expect(
      await findRollupMismatches(h.db, { projectId: s.projectId }),
    ).toEqual([mismatch(s.runId, "passed", "unresolved", c(1))]);
  });

  test("skips running runs and scopes to --project", async () => {
    const one = await seed(h, {
      checkpoints: [{ name: "a", verdict: "unresolved" }],
    });
    await setStatus(one.runId, "failed");
    // Stored `running` with every verdict set: not a finished run, not checked.
    await addReviewRun(h, one, {
      checkpoints: [{ name: "b", verdict: "passed" }],
      lifecycle: "running",
    });
    const two = await seed(h, {
      checkpoints: [{ name: "a", verdict: "new" }],
    });
    await setStatus(two.runId, "passed");

    expect(
      await findRollupMismatches(h.db, { projectId: one.projectId }),
    ).toEqual([mismatch(one.runId, "failed", "unresolved", c(1))]);

    const all = await findRollupMismatches(h.db, {});
    const mine = new Set([...one.runIds, ...two.runIds]);
    expect(all.filter((m) => mine.has(m.runId))).toEqual(
      [
        mismatch(one.runId, "failed", "unresolved", c(1)),
        mismatch(two.runId, "passed", "new", c(1)),
      ].sort(byRunId),
    );
  });

  test("pages through runs in id order: every batch size finds the same mismatches", async () => {
    const s = await seed(h, {
      checkpoints: [{ name: "r0", verdict: "passed" }],
    });
    for (let i = 1; i < 7; i++) {
      await addReviewRun(h, s, {
        checkpoints: [{ name: `r${i}`, verdict: "unresolved" }],
      });
    }
    const corrupted = [s.runIds[1]!, s.runIds[3]!, s.runIds[6]!];
    for (const id of corrupted) await setStatus(id, "passed");
    const expected = corrupted
      .map((runId) => mismatch(runId, "passed", "unresolved", c(1)))
      .sort(byRunId);

    for (const batchSize of [1, 2, 3, 500]) {
      expect(
        await findRollupMismatches(h.db, {
          projectId: s.projectId,
          batchSize,
        }),
      ).toEqual(expected);
    }
    await expect(
      findRollupMismatches(h.db, { projectId: s.projectId, batchSize: 0 }),
    ).rejects.toThrow(RangeError);
  });

  test("a counter mismatch is reported", async () => {
    const s = await seed(h, {
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "new" },
      ],
    });
    const settled = await addReviewRun(h, s, {
      checkpoints: [{ name: "c", verdict: "passed" }],
    });
    const partly = await addReviewRun(h, s, {
      checkpoints: [{ name: "d", verdict: "unresolved" }],
    });
    // A running run is checked for its counters (always 0), not its status.
    const running = await addReviewRun(h, s, {
      checkpoints: [{ name: "e", verdict: null }],
    });
    const aborted = await addReviewRun(h, s, {
      checkpoints: [{ name: "f", verdict: "unresolved" }],
      lifecycle: "aborted",
    });
    const overridden = await addReviewRun(h, s, {
      checkpoints: [{ name: "g", verdict: "unresolved" }],
      override: "passed",
    });
    expect(
      await findRollupMismatches(h.db, { projectId: s.projectId }),
    ).toEqual([]);

    // Stale both ways: too low, too high, one counter off, and positive on
    // runs that are not reviewable.
    await setCounters(s.runId, c(0));
    await setCounters(settled.runId, c(2, 1));
    await setCounters(partly.runId, c(1, 1));
    await setCounters(running.runId, c(3));
    await setCounters(aborted.runId, c(1, 1));
    await setCounters(overridden.runId, c(1));

    expect(
      await findRollupMismatches(h.db, { projectId: s.projectId }),
    ).toEqual(
      [
        mismatch(s.runId, "unresolved", "unresolved", [c(0), c(2)]),
        mismatch(settled.runId, "passed", "passed", [c(2, 1), c(0)]),
        mismatch(partly.runId, "unresolved", "unresolved", [c(1, 1), c(1)]),
        mismatch(running.runId, "running", "running", [c(3), c(0)]),
        mismatch(aborted.runId, "aborted", "aborted", [c(1, 1), c(0)]),
        mismatch(overridden.runId, "passed", "passed", [c(1), c(0)]),
      ].sort(byRunId),
    );
  });

  test("--repair-counters recomputes each run with stale counters, across projects, and never changes a status", async () => {
    const one = await seed(h, {
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "new" },
      ],
    });
    const oneSettled = await addReviewRun(h, one, {
      checkpoints: [{ name: "c", verdict: "passed" }],
    });
    const two = await seed(h, {
      checkpoints: [{ name: "a", verdict: "unresolved" }],
    });
    // Both wrong: a hand-corrupted status and stale counters. Recomputing it
    // would rewrite the status, so the repair leaves it to runbook §5.
    const both = await addReviewRun(h, two, {
      checkpoints: [{ name: "b", verdict: "new" }],
    });
    await setCounters(one.runId, c(0));
    await setCounters(oneSettled.runId, c(4, 2));
    await setCounters(two.runId, c(0));
    await setStatus(both.runId, "passed");
    await setCounters(both.runId, c(3));

    // The CLI's selection: every listed run whose counters are wrong.
    const listed = (await findRollupMismatches(h.db, {})).filter(
      (m) =>
        [one.runId, oneSettled.runId, two.runId, both.runId].includes(
          m.runId,
        ) &&
        (m.storedCounters.pendingSteps !== m.computedCounters.pendingSteps ||
          m.storedCounters.failedSteps !== m.computedCounters.failedSteps),
    );
    expect(listed.map((m) => m.runId).sort()).toEqual(
      [one.runId, oneSettled.runId, two.runId, both.runId].sort(),
    );

    const outcomes = await repairRunCounters(
      h.db,
      listed.map((m) => m.runId),
    );
    expect(outcomes).toEqual(
      [
        { runId: one.runId, outcome: "repaired" },
        { runId: oneSettled.runId, outcome: "repaired" },
        { runId: two.runId, outcome: "repaired" },
        { runId: both.runId, outcome: "status_differs" },
      ].sort(byRunId),
    );

    expect(await storedRun(one.runId)).toEqual({
      status: "unresolved",
      ...c(2),
    });
    expect(await storedRun(oneSettled.runId)).toEqual({
      status: "passed",
      ...c(0),
    });
    expect(await storedRun(two.runId)).toEqual({
      status: "unresolved",
      ...c(1),
    });
    // Untouched: status and counters as they were.
    expect(await storedRun(both.runId)).toEqual({ status: "passed", ...c(3) });

    // Both projects are clean but for the run the repair left alone.
    expect(
      await findRollupMismatches(h.db, { projectId: one.projectId }),
    ).toEqual([]);
    expect(
      await findRollupMismatches(h.db, { projectId: two.projectId }),
    ).toEqual([mismatch(both.runId, "passed", "new", [c(3), c(1)])]);

    // A second pass finds nothing left to do.
    expect(
      await repairRunCounters(h.db, [one.runId, oneSettled.runId, two.runId]),
    ).toEqual(
      [one.runId, oneSettled.runId, two.runId]
        .sort()
        .map((runId) => ({ runId, outcome: "already_right" })),
    );
  });

  test("--repair-counters waits for a writer holding the run, and never overwrites it", async () => {
    const s = await seed(h, {
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "unresolved" },
      ],
    });
    await setCounters(s.runId, c(0));

    // A writer: approves `a` and recomputes, holding the run until released.
    const writer = createDb();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const written = writer.db.transaction(async (tx) => {
      await recomputeRunStatus(tx, s.runId); // takes the run lock
      await tx.insert(checkpointDecisions).values({
        projectId: s.projectId,
        runId: s.runId,
        screenshotId: s.shots.a!.id,
        actionId: randomUUID(),
        decision: "approved",
        actorId: s.editor.id,
        source: "viewer",
      });
      await recomputeRunStatus(tx, s.runId);
      holding();
      await gate;
    });
    written.catch(() => holding());

    let repair: Promise<unknown> = Promise.resolve();
    try {
      await held;
      const repaired = repairRunCounters(h.db, [s.runId]);
      repair = repaired;
      const raced = await Promise.race([
        repaired.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"waiting">((resolve) =>
          setTimeout(() => resolve("waiting"), 300),
        ),
      ]);
      expect(raced).toBe("waiting");

      release();
      await written;
      // The writer committed its decision and its counters; the repair read
      // them under the lock and found nothing to change.
      expect(await repaired).toEqual([
        { runId: s.runId, outcome: "already_right" },
      ]);
      expect(await storedRun(s.runId)).toEqual({
        status: "unresolved",
        ...c(1),
      });
    } finally {
      release();
      await Promise.allSettled([written, repair]);
      await writer.close();
    }
  });

  test("listBaselineRepairs lists the baseline.repair audit rows, oldest first, scoped by --project", async () => {
    const one = await seed(h, {
      checkpoints: [{ name: "a", verdict: "passed" }],
    });
    const two = await seed(h, {
      checkpoints: [{ name: "a", verdict: "passed" }],
    });
    const t = Date.now() - 60_000;
    const rows = [
      {
        id: randomUUID(),
        createdAt: new Date(t),
        metadata: {
          variationId: one.shots.a!.variationId,
          runId: one.runId,
          branch: "feature/review",
          previousBaselineId: null,
          op: "inserted",
        },
      },
      {
        id: randomUUID(),
        createdAt: new Date(t + 1000),
        metadata: {
          variationId: two.shots.a!.variationId,
          runId: two.runId,
          branch: "main",
          previousBaselineId: randomUUID(),
          op: "updated",
        },
      },
    ];
    for (const r of rows) {
      repairAuditIds.push(r.id);
      await h.db.insert(auditLog).values({
        id: r.id,
        actorId: null,
        action: "baseline.repair",
        targetType: "baseline",
        targetId: randomUUID(),
        metadata: r.metadata,
        createdAt: r.createdAt,
      });
    }
    const shaped = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      ...r.metadata,
    }));

    expect(
      await listBaselineRepairs(h.db, { projectId: one.projectId }),
    ).toEqual([shaped[0]]);
    const all = await listBaselineRepairs(h.db, {});
    expect(all.filter((r) => repairAuditIds.includes(r.id))).toEqual(shaped);
  });
});
