import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditLog, diffRegions, eq, inArray, sql, testRuns } from "@furan/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  findRollupMismatches,
  listBaselineRepairs,
} from "../src/lib/review/rollup-verify.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * `findRollupMismatches` backs the read-only `verify-review-rollup` CLI (spec
 * §4.6): for every finished run it recomputes `rollupRunStatus` from the
 * stored verdicts, active decisions and override, and reports each run whose
 * stored status differs. `listBaselineRepairs` backs its `--repairs` flag.
 *
 * Everything is asserted on this file's own seeds (the functions also scan
 * whatever else the shared test database holds).
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
        { runId: s.runId, stored: "passed", computed: "running" },
        { runId: rejected.runId, stored: "failed", computed: "running" },
        { runId: unresolved.runId, stored: "unresolved", computed: "running" },
      ].sort(byRunId),
    );

    await h.db.transaction(async (tx) => {
      // Keep the migration's RAISE NOTICE off the test output.
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql.raw(BACKFILL_SQL));
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

    expect(
      await findRollupMismatches(h.db, { projectId: s.projectId }),
    ).toEqual([{ runId: s.runId, stored: "passed", computed: "unresolved" }]);
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
    ).toEqual([{ runId: one.runId, stored: "failed", computed: "unresolved" }]);

    const all = await findRollupMismatches(h.db, {});
    const mine = new Set([...one.runIds, ...two.runIds]);
    expect(all.filter((m) => mine.has(m.runId))).toEqual(
      [
        { runId: one.runId, stored: "failed", computed: "unresolved" },
        { runId: two.runId, stored: "passed", computed: "new" },
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
      .map((runId) => ({
        runId,
        stored: "passed" as const,
        computed: "unresolved" as const,
      }))
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
