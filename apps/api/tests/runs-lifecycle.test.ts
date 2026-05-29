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

interface LifecycleSeeded {
  memberId: string;
  memberJwt: string;
  outsiderJwt: string;
  projectId: string;
  buildId: string;
}

async function seedBase(h: TestApp): Promise<LifecycleSeeded> {
  await h.db.delete(testRuns);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [member] = await h.db
    .insert(users)
    .values({
      email: "lifecycle-member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Life",
      lastName: "Cycle",
      role: "editor",
      isActive: true,
    })
    .returning();

  // A second user with no membership in any project — used to verify the
  // project-member gate rejects non-members with 403.
  const [outsider] = await h.db
    .insert(users)
    .values({
      email: "lifecycle-outsider@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Out",
      lastName: "Sider",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "lifecycle-proj" })
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

interface SeededRun {
  runId: string;
  headers: Record<string, string>;
  outsiderHeaders: Record<string, string>;
}

async function seedAuthedRunNoCheckpoints(h: TestApp): Promise<SeededRun> {
  const s = await seedBase(h);
  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: s.buildId,
      projectId: s.projectId,
      name: "lifecycle-run",
      branchName: "main",
      status: "running",
    })
    .returning();
  return {
    runId: run!.id,
    headers: { authorization: `Bearer ${s.memberJwt}` },
    outsiderHeaders: { authorization: `Bearer ${s.outsiderJwt}` },
  };
}

d("POST /runs/:id/complete + /abort", () => {
  let h: TestApp;

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    await h.close();
  });

  test("complete with zero checkpoints lands status=empty", async () => {
    const { runId, headers } = await seedAuthedRunNoCheckpoints(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/complete`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      runId: string;
      status: string;
      checkpointCount: number;
    };
    expect(body.status).toBe("empty");
    expect(body.checkpointCount).toBe(0);

    const persisted = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, runId))
      .limit(1);
    expect(persisted[0]?.completedAt).not.toBeNull();
  });

  test("abort marks the run aborted", async () => {
    const { runId, headers } = await seedAuthedRunNoCheckpoints(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/abort`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId, status: "aborted" });

    const persisted = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, runId))
      .limit(1);
    expect(persisted[0]?.status).toBe("aborted");
    expect(persisted[0]?.completedAt).not.toBeNull();
  });

  test("complete without auth → 401", async () => {
    const { runId } = await seedAuthedRunNoCheckpoints(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/complete`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("abort without auth → 401", async () => {
    const { runId } = await seedAuthedRunNoCheckpoints(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/abort`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("complete with invalid uuid → 400", async () => {
    const { headers } = await seedAuthedRunNoCheckpoints(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/runs/not-a-uuid/complete",
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  test("non-member cannot complete another project's run → 403", async () => {
    const { runId, outsiderHeaders } = await seedAuthedRunNoCheckpoints(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/complete`,
      headers: outsiderHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  test("non-member cannot abort another project's run → 403", async () => {
    const { runId, outsiderHeaders } = await seedAuthedRunNoCheckpoints(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/abort`,
      headers: outsiderHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  test("complete with unknown run id → 400 (no project scope)", async () => {
    const { headers } = await seedAuthedRunNoCheckpoints(h);
    const unknownId = "00000000-0000-0000-0000-000000000000";
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${unknownId}/complete`,
      headers,
    });
    // requireProjectMember returns 400 when the resolver returns null
    // (run not found → no project scope).
    expect(res.statusCode).toBe(400);
  });
});
