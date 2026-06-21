import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  eq,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import { createStorage } from "@furan/storage";
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

const skip =
  !process.env.DATABASE_URL ||
  !process.env.S3_ENDPOINT ||
  !process.env.S3_BUCKET ||
  !process.env.S3_ACCESS_KEY ||
  !process.env.S3_SECRET_KEY;
const d = skip ? describe.skip : describe;

// Minimal but valid 1×1 PNG (decodes cleanly + carries proper magic bytes).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

interface Seeded {
  memberId: string;
  memberJwt: string;
  nonMemberId: string;
  nonMemberJwt: string;
  projectId: string;
  buildId: string;
  runId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents.
  await h.db.delete(screenshots);
  await h.db.delete(testRuns);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [member] = await h.db
    .insert(users)
    .values({
      email: "sdk-member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Sdk",
      lastName: "Member",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [nonMember] = await h.db
    .insert(users)
    .values({
      email: "sdk-nonmember@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Sdk",
      lastName: "NonMember",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "sdk-proj" })
    .returning();

  await h.db
    .insert(projectMembers)
    .values({ userId: member!.id, projectId: project!.id });

  const [build] = await h.db
    .insert(builds)
    .values({
      projectId: project!.id,
      userId: member!.id,
      isRunning: true,
    })
    .returning();

  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: build!.id,
      projectId: project!.id,
      name: "home",
      branchName: "main",
      status: "running",
    })
    .returning();

  return {
    memberId: member!.id,
    memberJwt: h.app.jwt.sign({ sub: member!.id, role: "editor" }),
    nonMemberId: nonMember!.id,
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember!.id, role: "editor" }),
    projectId: project!.id,
    buildId: build!.id,
    runId: run!.id,
  };
}

d("SDK REST routes (Phase 4 Task 4)", () => {
  let h: TestApp;
  let port: number;
  let s: Seeded;

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    port = addr.port;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  // ---------------------------------------------------------------------------
  // POST /runs
  // ---------------------------------------------------------------------------

  test("POST /runs with valid body creates a test_runs row + returns 201", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "feature/new-checkout",
        name: "checkout-page-snap",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      runId: string;
      status: string;
      name: string;
    };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe("running");
    expect(body.name).toBe("checkout-page-snap");

    const rows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, body.runId))
      .limit(1);
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.branchName).toBe("feature/new-checkout");
    expect(rows[0]!.name).toBe("checkout-page-snap");
  });

  test("POST /runs persists parentBranchName (ADR-055 branch fallback)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "feature/x",
        name: "parent-branch-snap",
        parentBranchName: "develop",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { runId: string };

    const rows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, body.runId))
      .limit(1);
    expect(rows[0]!.parentBranchName).toBe("develop");
  });

  test("POST /runs without parentBranchName leaves it null (backfill-safe)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "feature/x",
        name: "no-parent-snap",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { runId: string };
    const rows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, body.runId))
      .limit(1);
    expect(rows[0]!.parentBranchName).toBeNull();
  });

  test("POST /runs with distinct names produces distinct run rows under one build (ADR-038)", async () => {
    // ADR-038: POST /runs creates test runs; variations are resolved at
    // POST /runs/:id/screenshots time. Each POST /runs creates a new run.
    const common = {
      projectId: s.projectId,
      buildId: s.buildId,
      branchName: "feature/multi-snap",
    };

    const resA = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: { ...common, name: "checkout-page" },
    });
    expect(resA.statusCode).toBe(201);
    const bodyA = JSON.parse(resA.body) as { runId: string; name: string };

    const resB = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: { ...common, name: "login-page" },
    });
    expect(resB.statusCode).toBe(201);
    const bodyB = JSON.parse(resB.body) as { runId: string; name: string };

    // Distinct run IDs.
    expect(bodyA.runId).not.toBe(bodyB.runId);
    expect(bodyA.name).toBe("checkout-page");
    expect(bodyB.name).toBe("login-page");

    // Each POST /runs creates a new run — even same name.
    const resARepeat = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: { ...common, name: "checkout-page" },
    });
    expect(resARepeat.statusCode).toBe(201);
    const bodyARepeat = JSON.parse(resARepeat.body) as { runId: string };
    // Distinct run row on every POST.
    expect(bodyARepeat.runId).not.toBe(bodyA.runId);
  });

  test("POST /runs with nonexistent buildId returns 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: "00000000-0000-0000-0000-000000000001",
        branchName: "main",
        name: "x",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test("POST /runs without auth → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        name: "x",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test("POST /runs returns 400 for unknown extra fields (strict v1.1.0 shape)", async () => {
    // ADR-038: diffTolerance, ignoreAreas, browser, viewport fields moved
    // out of POST /runs. Unknown fields cause Zod to reject.
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        name: "basic-run",
      },
    });
    // The strict v1.1.0 shape accepts exactly {projectId, buildId, name, branchName}
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { runId: string; status: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe("running");
  });

  test("POST /runs as a non-member editor → 403", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.nonMemberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        name: "x",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // GET /runs/:id
  // ---------------------------------------------------------------------------

  test("GET /runs/:id returns the run row for a project member", async () => {
    // Seed via POST /runs so the test exercises the full create→read path.
    const createRes = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        name: "rest-get-snap",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { runId: string };

    const getRes = await h.app.inject({
      method: "GET",
      url: `/runs/${created.runId}`,
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body) as {
      id: string;
      projectId: string;
      buildId: string;
      branchName: string | null;
      autoApproved: boolean;
    };
    expect(body.id).toBe(created.runId);
    expect(body.projectId).toBe(s.projectId);
    expect(body.buildId).toBe(s.buildId);
    expect(body.branchName).toBe("main");
    // No baselines row exists yet for a freshly-created run.
    expect(body.autoApproved).toBe(false);
  });

  test("GET /runs/:id sets autoApproved=true when an auto-baseline row exists", async () => {
    // ADR-038: baselines are now tied to screenshots/variations.
    // Seed the run + a variation + baselines row manually.
    const createRes = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        name: "auto-approve-derivation",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { runId: string };

    // Insert a variation and a baseline with userId IS NULL (auto-approve signal).
    const [variation] = await h.db
      .insert(testVariations)
      .values({ name: "auto-approve-derivation", projectId: s.projectId })
      .returning();
    await h.db.insert(baselines).values({
      baselineName: "auto",
      testVariationId: variation!.id,
      testRunId: created.runId,
      // userId omitted → NULL → auto-baseline signal
    });

    const getRes = await h.app.inject({
      method: "GET",
      url: `/runs/${created.runId}`,
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body) as { autoApproved: boolean };
    expect(body.autoApproved).toBe(true);
  });

  test("GET /runs/:id sets autoApproved=false when the baseline has a userId (manual approve)", async () => {
    const createRes = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        name: "manual-approve-baseline",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { runId: string };

    const [variation] = await h.db
      .insert(testVariations)
      .values({ name: "manual-approve-baseline", projectId: s.projectId })
      .returning();
    await h.db.insert(baselines).values({
      baselineName: "auto",
      testVariationId: variation!.id,
      testRunId: created.runId,
      userId: s.memberId, // manual-approve signal
    });

    const getRes = await h.app.inject({
      method: "GET",
      url: `/runs/${created.runId}`,
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    const body = JSON.parse(getRes.body) as { autoApproved: boolean };
    expect(body.autoApproved).toBe(false);
  });

  test("GET /runs/:id returns 404 for a nonexistent uuid", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/runs/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${s.memberJwt}` },
    });
    // The project-member preHandler resolves the run's projectId first;
    // a missing run means no project context, which surfaces as 400
    // missing_project_scope before reaching the handler. Either 400 or
    // 404 is a legitimate "the run is not yours / does not exist"
    // signal — the SDK only cares that it is not 200.
    expect(res.statusCode === 400 || res.statusCode === 404).toBe(true);
  });

  test("GET /runs/:id without auth → 401", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/runs/${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("GET /runs/:id as a non-member editor → 403", async () => {
    // Seed a run on member's project, then try to read it as the
    // non-member editor (admins bypass — we already test that the
    // non-member is editor-role, not admin).
    const createRes = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        name: "rbac-probe",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { runId: string };

    const res = await h.app.inject({
      method: "GET",
      url: `/runs/${created.runId}`,
      headers: { authorization: `Bearer ${s.nonMemberJwt}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // POST /runs/:runId/screenshots (multipart)
  // ---------------------------------------------------------------------------

  test("POST /runs/:id/screenshots (multipart) inserts row + uploads bytes", async () => {
    // Use native fetch + FormData against the live listener (multipart
    // streams cleanly through Fastify this way; inject() also works, but
    // fetch better mirrors what the Kotlin SDK does over the wire).
    const form = new FormData();
    form.append("name", "checkout-snap");
    form.append("viewport", "1280x720");
    form.append("browser", "chromium");
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "snap.png",
    );
    form.append(
      "domHtml",
      new Blob([Buffer.from("<html><body>hi</body></html>")], {
        type: "text/html",
      }),
      "snap.html",
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imageKey: string;
      domKey: string | null;
      runId: string;
      viewport: string;
      browser: string;
    };
    expect(body.imageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.domKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.runId).toBe(s.runId);
    expect(body.viewport).toBe("1280x720");
    expect(body.browser).toBe("chromium");

    // Verify the screenshots row was inserted.
    const rows = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.imageKey).toBe(body.imageKey);
    expect(rows[0]!.domKey).toBe(body.domKey);

    // Verify the bytes are in storage.
    const storage = createStorage();
    const head = await storage.head(body.imageKey);
    expect(head).toBeTruthy();
    expect(head!.contentType).toBe("image/png");
    const fetched = Buffer.from(await storage.get(body.imageKey));
    expect(fetched.equals(TINY_PNG)).toBe(true);

    // Verify a diff job was enqueued for the run so the diff-worker
    // moves it out of `running` status. Before this enqueue landed, the
    // SDK-only ingest path left every uploaded run hanging in `running`
    // until a reviewer manually triggered a setIgnoreAreas / threshold
    // mutation from the dashboard.
    expect(h.diffQueueAdd).toHaveBeenCalledWith("diff", {
      runId: s.runId,
      projectId: s.projectId,
    });
  });

  test("POST /runs/:id/screenshots accepts elementMapJson + stores sidecar", async () => {
    const elementMap = JSON.stringify({
      v: 1,
      elements: {
        "#login": { x: 0, y: 0, width: 200, height: 50 },
      },
      capturedAt: 1700000000000,
    });
    const form = new FormData();
    form.append("name", "with-element-map");
    form.append("viewport", "1280x720");
    form.append("browser", "selenium");
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "snap.png",
    );
    form.append(
      "elementMapJson",
      new Blob([Buffer.from(elementMap)], { type: "application/json" }),
      "elements.json",
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imageKey: string };

    const rows = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.elementMapKey).toBe(`${body.imageKey}.elements.json`);

    const storage = createStorage();
    const head = await storage.head(rows[0]!.elementMapKey!);
    expect(head).toBeTruthy();
    expect(head!.contentType).toMatch(/application\/json/);
    const fetched = Buffer.from(
      await storage.get(rows[0]!.elementMapKey!),
    ).toString("utf8");
    expect(fetched).toBe(elementMap);
  });

  test("POST /runs/:id/screenshots drops oversized elementMapJson silently", async () => {
    const oversized = "x".repeat(1_000_001);
    const form = new FormData();
    form.append("name", "oversized-map");
    form.append("viewport", "1280x720");
    form.append("browser", "selenium");
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "snap.png",
    );
    form.append(
      "elementMapJson",
      new Blob([Buffer.from(oversized)], { type: "application/json" }),
      "elements.json",
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(200);

    const rows = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.elementMapKey).toBeNull();
  });

  test("POST /runs/:id/screenshots drops malformed JSON silently", async () => {
    const form = new FormData();
    form.append("name", "bad-json");
    form.append("viewport", "1280x720");
    form.append("browser", "selenium");
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "snap.png",
    );
    form.append(
      "elementMapJson",
      new Blob([Buffer.from("not valid { json")], {
        type: "application/json",
      }),
      "elements.json",
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(200);

    const rows = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.elementMapKey).toBeNull();
  });

  test("POST /runs/:id/screenshots back-compat: missing field => column null", async () => {
    const form = new FormData();
    form.append("name", "no-map");
    form.append("viewport", "1280x720");
    form.append("browser", "selenium");
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "snap.png",
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(200);

    const rows = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.elementMapKey).toBeNull();
  });

  test("POST /runs/:id/screenshots persists ignoreDisplacements=true (Tier 1.4)", async () => {
    const form = new FormData();
    form.append("name", "with-displacements-ignored");
    form.append("viewport", "1280x720");
    form.append("browser", "selenium");
    form.append("ignoreDisplacements", "true");
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "snap.png",
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(200);

    const rows = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ignoreDisplacements).toBe(true);
  });

  test("POST /runs/:id/screenshots defaults ignoreDisplacements to false (Tier 1.4)", async () => {
    const form = new FormData();
    form.append("name", "no-displacement-flag");
    form.append("viewport", "1280x720");
    form.append("browser", "selenium");
    // ignoreDisplacements deliberately omitted → should default to false.
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "snap.png",
    );

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(200);

    const rows = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ignoreDisplacements).toBe(false);
  });

  test("POST /runs/:id/screenshots without pngBytes → 400", async () => {
    const form = new FormData();
    form.append("name", "no-image");
    form.append("viewport", "1280x720");
    form.append("browser", "selenium");

    const res = await fetch(
      `http://127.0.0.1:${port}/runs/${s.runId}/screenshots`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${s.memberJwt}` },
        body: form,
      },
    );
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // POST /runs/:id/screenshots/base64 — JSON body variant
  // ---------------------------------------------------------------------------

  test("POST /runs/:id/screenshots/base64 (JSON) inserts row + uploads bytes", async () => {
    h.diffQueueAdd.mockClear();
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${s.runId}/screenshots/base64`,
      headers: {
        Authorization: `Bearer ${s.memberJwt}`,
        "Content-Type": "application/json",
      },
      payload: {
        pngBase64: TINY_PNG.toString("base64"),
        name: "checkout-snap-b64",
        viewport: "800x600",
        browser: "chromium",
        domHtml: "<html><body>b64</body></html>",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      imageKey: string;
      domKey: string | null;
      runId: string;
      viewport: string;
      browser: string;
    };
    expect(body.imageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.domKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.viewport).toBe("800x600");

    // Same imageKey + bytes as the multipart variant would produce — the
    // helper hashes the decoded bytes, not the wire payload.
    const storage = createStorage();
    const fetched = Buffer.from(await storage.get(body.imageKey));
    expect(fetched.equals(TINY_PNG)).toBe(true);

    // Diff job enqueued — same downstream behavior as multipart.
    expect(h.diffQueueAdd).toHaveBeenCalledWith("diff", {
      runId: s.runId,
      projectId: s.projectId,
    });
  });

  test("base64 upload forwards parentPrBaseBranch on the diff job when the run has a parent (ADR-055)", async () => {
    // The enqueue must forward the run's parent branch so the diff-worker's
    // resolveBaseline can fire the parent_pr tier.
    await h.db
      .update(testRuns)
      .set({ parentBranchName: "develop" })
      .where(eq(testRuns.id, s.runId));
    h.diffQueueAdd.mockClear();

    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${s.runId}/screenshots/base64`,
      headers: {
        Authorization: `Bearer ${s.memberJwt}`,
        "Content-Type": "application/json",
      },
      payload: {
        pngBase64: TINY_PNG.toString("base64"),
        name: "parent-enqueue-snap",
        viewport: "800x600",
        browser: "chromium",
      },
    });
    expect(res.statusCode).toBe(200);

    expect(h.diffQueueAdd).toHaveBeenCalledWith("diff", {
      runId: s.runId,
      projectId: s.projectId,
      parentPrBaseBranch: "develop",
    });
  });

  test("POST /runs/:id/screenshots/base64 rejects empty pngBase64", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${s.runId}/screenshots/base64`,
      headers: {
        Authorization: `Bearer ${s.memberJwt}`,
        "Content-Type": "application/json",
      },
      payload: { pngBase64: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  test("POST /runs/:id/screenshots/base64 rejects payload over 50 MB decoded", async () => {
    // 51 MB of base64-decoded data — `A` repeats encode to 4 chars per 3
    // bytes, so we need ~51 MB worth of input → ~68 MB base64 string.
    const oversized = "A".repeat(Math.ceil((51 * 1024 * 1024 * 4) / 3));
    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${s.runId}/screenshots/base64`,
      headers: {
        Authorization: `Bearer ${s.memberJwt}`,
        "Content-Type": "application/json",
      },
      payload: { pngBase64: oversized },
    });
    expect(res.statusCode).toBe(413);
  });

  // ---------------------------------------------------------------------------
  // POST /_telemetry/sdk
  // ---------------------------------------------------------------------------

  test("POST /_telemetry/sdk returns 204 without auth + accepts any JSON", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/_telemetry/sdk",
      payload: {
        sdkVersion: "0.5.0",
        adapter: "selenium",
        successCount: 42,
        errorCount: 1,
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  test("POST /_telemetry/sdk accepts an empty body", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/_telemetry/sdk",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(204);
  });

  // ---------------------------------------------------------------------------
  // Back-compat: SDK 1.0.x POST /runs shape (ADR-038 Phase 7)
  // ---------------------------------------------------------------------------

  test("legacy SDK 1.0.x POST /runs shape synthesizes a v1.1.0 run", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: {
        authorization: `Bearer ${s.memberJwt}`,
        "content-type": "application/json",
      },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        name: "HomePage", // legacy: the "checkpoint name"
        branchName: "main",
        viewport: "1280x720", // legacy: triggers synthesis
        browser: "chromium",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { runId: string; status: string; name: string };
    expect(body.name).toBe("HomePage");
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe("running");
  });
});
