import type { AddressInfo } from "node:net";

import {
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
  await h.db.delete(testVariations);
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

  const [variation] = await h.db
    .insert(testVariations)
    .values({ name: "home", projectId: project!.id })
    .returning();

  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: build!.id,
      projectId: project!.id,
      testVariationId: variation!.id,
      status: "new",
      browser: "selenium",
      viewport: "1280x720",
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

  test("POST /runs with valid body creates a test_runs row + returns 200", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: { authorization: `Bearer ${s.memberJwt}` },
      payload: {
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "feature/new-checkout",
        name: "checkout-page-snap",
        browser: "selenium",
        viewport: "1440x900",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { id: string; projectId: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.projectId).toBe(s.projectId);

    const rows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, body.id))
      .limit(1);
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.branchName).toBe("feature/new-checkout");
    expect(rows[0]!.browser).toBe("selenium");
    expect(rows[0]!.viewport).toBe("1440x900");
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
});
