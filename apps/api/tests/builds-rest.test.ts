import {
  builds,
  diffRegions,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  editorId: string;
  editorJwt: string;
  projectId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents.
  await h.db.delete(diffRegions);
  await h.db.delete(screenshots);
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [editor] = await h.db
    .insert(users)
    .values({
      email: "ed@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ed",
      lastName: "X",
      role: "editor",
      isActive: true,
    })
    .returning();
  if (!editor) throw new Error("editor not seeded");

  const [proj] = await h.db
    .insert(projects)
    .values({ name: "p1", mainBranchName: "main" })
    .returning();
  if (!proj) throw new Error("project not seeded");

  await h.db
    .insert(projectMembers)
    .values({ projectId: proj.id, userId: editor.id });

  return {
    editorId: editor.id,
    editorJwt: h.app.jwt.sign({ sub: editor.id, role: "editor" }),
    projectId: proj.id,
  };
}

d("builds REST — find-or-create + properties", () => {
  let h: TestApp;
  let s: Seeded;
  const url = (id: string) => `/projects/${id}/builds`;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  test("POST with new ciBuildId returns 201", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { ciBuildId: "ci-build-1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ciBuildId).toBe("ci-build-1");
    expect(body.properties).toEqual({});
  });

  test("POST with existing ciBuildId returns 200 and same id", async () => {
    const first = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { ciBuildId: "ci-build-2" },
    });
    const firstId = first.json().id;
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { ciBuildId: "ci-build-2" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(firstId);
  });

  test("POST with null ciBuildId always inserts", async () => {
    const a = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: {},
    });
    const b = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: {},
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
  });

  test("properties merge on reattach (new keys win on collision)", async () => {
    await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: {
        ciBuildId: "ci-build-3",
        properties: { region: "us-east-1", shard: "1" },
      },
    });
    const res = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: {
        ciBuildId: "ci-build-3",
        properties: { region: "us-west-2", feature: "new-cart" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().properties).toEqual({
      region: "us-west-2",
      shard: "1",
      feature: "new-cart",
    });
  });

  test("name/number/branchName fill only when currently null (first shard wins)", async () => {
    await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { ciBuildId: "ci-build-4", name: "nightly", number: 42 },
    });
    const res = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { ciBuildId: "ci-build-4", name: "different", number: 99 },
    });
    expect(res.json().name).toBe("nightly");
    expect(res.json().number).toBe(42);
  });

  test("validation — > 20 properties rejected", async () => {
    const props: Record<string, string> = {};
    for (let i = 0; i < 21; i++) props[`key${i}`] = "v";
    const res = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { properties: props },
    });
    expect(res.statusCode).toBe(400);
  });

  test("validation — property key with invalid char rejected", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { properties: { "bad@key": "v" } },
    });
    expect(res.statusCode).toBe(400);
  });

  test("validation — name > 200 chars rejected", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { name: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
  });

  test("8 concurrent POSTs with same ciBuildId produce 1 row", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.app.inject({
          method: "POST",
          url: url(s.projectId),
          headers: { authorization: `Bearer ${s.editorJwt}` },
          payload: { ciBuildId: "race-build" },
        }),
      ),
    );
    const ids = new Set(results.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    const inserted = results.filter((r) => r.statusCode === 201).length;
    expect(inserted).toBe(1);
  });

  test("telemetry counter increments on reattach", async () => {
    const before = await h.telemetry.metrics.metrics();
    const beforeCreated = parseInt(
      before.match(
        /furan_builds_create_total\{[^}]*outcome="created"[^}]*\}\s+(\d+)/,
      )?.[1] ?? "0",
      10,
    );
    const beforeReattached = parseInt(
      before.match(
        /furan_builds_create_total\{[^}]*outcome="reattached"[^}]*\}\s+(\d+)/,
      )?.[1] ?? "0",
      10,
    );

    await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { ciBuildId: "metrics-build" },
    });
    await h.app.inject({
      method: "POST",
      url: url(s.projectId),
      headers: { authorization: `Bearer ${s.editorJwt}` },
      payload: { ciBuildId: "metrics-build" },
    });

    const after = await h.telemetry.metrics.metrics();
    const afterCreated = parseInt(
      after.match(
        /furan_builds_create_total\{[^}]*outcome="created"[^}]*\}\s+(\d+)/,
      )?.[1] ?? "0",
      10,
    );
    const afterReattached = parseInt(
      after.match(
        /furan_builds_create_total\{[^}]*outcome="reattached"[^}]*\}\s+(\d+)/,
      )?.[1] ?? "0",
      10,
    );

    expect(afterCreated - beforeCreated).toBe(1);
    expect(afterReattached - beforeReattached).toBe(1);
  });

  test("POST to non-existent project → 404 project_not_found (no FK leak)", async () => {
    // Use an admin so requireProjectMember bypasses (the membership check
    // doesn't validate existence); we want to exercise the explicit
    // existence guard that turns a downstream FK violation into a clean
    // 404 instead of an opaque 500.
    const [admin] = await h.db
      .insert(users)
      .values({
        email: "a@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "A",
        lastName: "X",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");
    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });
    const ghostProjectId = "00000000-0000-0000-0000-000000000000";
    const res = await h.app.inject({
      method: "POST",
      url: url(ghostProjectId),
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: { ciBuildId: "leak-probe" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "project_not_found" });
    // Critical: the body must NOT contain any DB-internal info.
    const bodyText = res.body;
    expect(bodyText).not.toContain("insert into");
    expect(bodyText).not.toContain("builds_project_id_projects_id_fk");
    expect(bodyText).not.toContain(ghostProjectId);
  });
});
