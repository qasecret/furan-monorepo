/**
 * Integration test for POST /runs/:id/approve (SDK `saveNewTests`): a thin
 * wrapper over the decision core that approves every pending checkpoint of the
 * run with `source: "sdk"` (spec §5.7).
 *
 * NOTE: This test is intentionally NOT executed locally — the api integration
 * suite TRUNCATEs the shared dev Postgres which holds live demo data. It is
 * written for CI to run against a clean database. Verify locally with
 * `pnpm --filter @furan/api typecheck` and `pnpm --filter @furan/api lint`.
 */

import {
  baselines,
  builds,
  checkpointDecisions,
  eq,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  tokens,
  users,
} from "@furan/db";
import type { CheckpointVerdict } from "@furan/shared-types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import { generateRawToken } from "../src/lib/token.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.S3_ENDPOINT ||
  !process.env.S3_BUCKET ||
  !process.env.S3_ACCESS_KEY ||
  !process.env.S3_SECRET_KEY;
const d = skip ? describe.skip : describe;

interface ApproveSeeded {
  memberId: string;
  memberJwt: string;
  outsiderJwt: string;
  projectId: string;
  buildId: string;
}

async function seedBase(h: TestApp): Promise<ApproveSeeded> {
  await h.db.delete(testRuns);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [member] = await h.db
    .insert(users)
    .values({
      email: "approve-member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "App",
      lastName: "Rove",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [outsider] = await h.db
    .insert(users)
    .values({
      email: "approve-outsider@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Out",
      lastName: "Sider",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "approve-proj" })
    .returning();

  await h.db
    .insert(projectMembers)
    .values({ userId: member!.id, projectId: project!.id });

  const [build] = await h.db
    .insert(builds)
    .values({ projectId: project!.id, userId: member!.id, isRunning: true })
    .returning();

  return {
    memberId: member!.id,
    memberJwt: h.app.jwt.sign({ sub: member!.id, role: "editor" }),
    outsiderJwt: h.app.jwt.sign({ sub: outsider!.id, role: "editor" }),
    projectId: project!.id,
    buildId: build!.id,
  };
}

interface SeededApproveRun {
  runId: string;
  memberId: string;
  projectId: string;
  headers: Record<string, string>;
  outsiderHeaders: Record<string, string>;
}

/** Gives `runId` a diffed checkpoint (its own variation) with `verdict`. */
async function addCheckpoint(
  h: TestApp,
  s: { projectId: string },
  runId: string,
  name: string,
  verdict: CheckpointVerdict,
) {
  const [variation] = await h.db
    .insert(testVariations)
    .values({ name, projectId: s.projectId, branchName: "main" })
    .returning();
  const [shot] = await h.db
    .insert(screenshots)
    .values({
      runId,
      projectId: s.projectId,
      testVariationId: variation!.id,
      name,
      viewport: "1280x720",
      browser: "chromium",
      imageKey: `${name}-${runId.slice(0, 8)}`,
      verdict,
      verdictAt: new Date(),
    })
    .returning();
  return { shot: shot!, variation: variation! };
}

const decisionsOf = (h: TestApp, runId: string) =>
  h.db
    .select()
    .from(checkpointDecisions)
    .where(eq(checkpointDecisions.runId, runId));

async function seedNewRun(h: TestApp): Promise<SeededApproveRun> {
  const s = await seedBase(h);
  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: s.buildId,
      projectId: s.projectId,
      name: "approve-run",
      branchName: "main",
      // First-baseline path: the diff found no baseline (verdict `new`).
      status: "new",
    })
    .returning();
  await addCheckpoint(h, s, run!.id, "approve-step", "new");
  return {
    runId: run!.id,
    memberId: s.memberId,
    projectId: s.projectId,
    headers: { authorization: `Bearer ${s.memberJwt}` },
    outsiderHeaders: { authorization: `Bearer ${s.outsiderJwt}` },
  };
}

d("POST /runs/:id/approve", () => {
  let h: TestApp;

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    await h.close();
  });

  test("approve a new run → 200 + { runId, approved: true }", async () => {
    const { runId, headers, memberId } = await seedNewRun(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/approve`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId, approved: true });

    // Verify the DB row transitioned to "passed"
    const rows = await h.db
      .select({ status: testRuns.status, merge: testRuns.merge })
      .from(testRuns)
      .where(eq(testRuns.id, runId))
      .limit(1);
    expect(rows[0]?.status).toBe("passed");
    expect(rows[0]?.merge).toBe(true);

    // Through the decision core: one approve per pending checkpoint, by the
    // caller, tagged as the SDK's.
    const decisions = await decisionsOf(h, runId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: "approved",
      source: "sdk",
      actorId: memberId,
    });
  });

  test("an SDK token's approve is decided as its user, source sdk", async () => {
    const { runId, memberId } = await seedNewRun(h);
    const { raw, hash } = generateRawToken();
    await h.db
      .insert(tokens)
      .values({ userId: memberId, label: "approve-ci", hash });
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/approve`,
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(res.statusCode).toBe(200);
    const decisions = await decisionsOf(h, runId);
    expect(decisions.map((d) => [d.actorId, d.source])).toEqual([
      [memberId, "sdk"],
    ]);
  });

  test("approve a fully passed run → 200 and writes nothing (zero pending is a no-op)", async () => {
    const s = await seedBase(h);
    const [run] = await h.db
      .insert(testRuns)
      .values({
        buildId: s.buildId,
        projectId: s.projectId,
        name: "approve-passed",
        branchName: "main",
        status: "passed",
        merge: true,
      })
      .returning();
    const { variation } = await addCheckpoint(
      h,
      s,
      run!.id,
      "passed-step",
      "passed",
    );
    await h.db.insert(baselines).values({
      baselineName: "passed-step-baseline",
      testVariationId: variation.id,
      testRunId: run!.id,
      branchName: "main",
    });
    const baselinesBefore = await h.db.select().from(baselines);

    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${run!.id}/approve`,
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    // It used to re-promote a passed run; now there is nothing to decide.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: run!.id, approved: true });
    expect(await decisionsOf(h, run!.id)).toHaveLength(0);
    expect(await h.db.select().from(baselines)).toEqual(baselinesBefore);
    const [after] = await h.db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, run!.id));
    expect(after?.status).toBe("passed");
  });

  test("a refused approve (overridden run) → 409 approve_failed", async () => {
    const s = await seedBase(h);
    const [run] = await h.db
      .insert(testRuns)
      .values({
        buildId: s.buildId,
        projectId: s.projectId,
        name: "approve-overridden",
        branchName: "main",
        status: "passed",
        statusOverride: "passed",
      })
      .returning();
    await addCheckpoint(h, s, run!.id, "overridden-step", "unresolved");
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${run!.id}/approve`,
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    // The core refuses (PRECONDITION_FAILED run_overridden): 409, as before.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "approve_failed" });
    expect(await decisionsOf(h, run!.id)).toHaveLength(0);
  });

  test("approve without auth → 401", async () => {
    const { runId } = await seedNewRun(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/approve`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("approve with invalid uuid → 400", async () => {
    const { headers } = await seedNewRun(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/runs/not-a-uuid/approve",
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  test("non-member cannot approve another project's run → 403", async () => {
    const { runId, outsiderHeaders } = await seedNewRun(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/approve`,
      headers: outsiderHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  test("approve with unknown run id → 400 (no project scope)", async () => {
    const { headers } = await seedNewRun(h);
    const unknownId = "00000000-0000-0000-0000-000000000000";
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${unknownId}/approve`,
      headers,
    });
    // requireProjectMember returns 400 when the resolver returns null
    // (the run doesn't exist so resolveRunProjectId returns null before
    // the handler is even reached — this is NOT a 404 from the handler).
    expect(res.statusCode).toBe(400);
  });

  test("approve a run with un-approvable status → 409", async () => {
    const s = await seedBase(h);
    const [run] = await h.db
      .insert(testRuns)
      .values({
        buildId: s.buildId,
        projectId: s.projectId,
        name: "approve-run-running",
        branchName: "main",
        // A run still being diffed is not reviewable.
        status: "running",
      })
      .returning();
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${run!.id}/approve`,
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    // The core refuses (PRECONDITION_FAILED not_reviewable) → 409 Conflict
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "approve_failed" });
  });
});
