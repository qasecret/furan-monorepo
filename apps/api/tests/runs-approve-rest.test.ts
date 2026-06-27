/**
 * Integration test for POST /runs/:id/approve (REST wrapper over approveRun).
 *
 * NOTE: This test is intentionally NOT executed locally — the api integration
 * suite TRUNCATEs the shared dev Postgres which holds live demo data. It is
 * written for CI to run against a clean database. Verify locally with
 * `pnpm --filter @furan/api typecheck` and `pnpm --filter @furan/api lint`.
 */

import {
  builds,
  eq,
  projectMembers,
  projects,
  testRuns,
  users,
} from "@furan/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";

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
  headers: Record<string, string>;
  outsiderHeaders: Record<string, string>;
}

async function seedNewRun(h: TestApp): Promise<SeededApproveRun> {
  const s = await seedBase(h);
  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: s.buildId,
      projectId: s.projectId,
      name: "approve-run",
      branchName: "main",
      // "new" is in APPROVE_LEGAL_FROM — first-baseline materialisation path
      status: "new",
    })
    .returning();
  return {
    runId: run!.id,
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
    const { runId, headers } = await seedNewRun(h);
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
        // "running" is NOT in APPROVE_LEGAL_FROM
        status: "running",
      })
      .returning();
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${run!.id}/approve`,
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "approve_failed" });
  });
});
