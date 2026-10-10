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

// Minimal but valid 1×1 PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

interface CkSeeded {
  memberId: string;
  memberJwt: string;
  projectId: string;
  buildId: string;
  runId: string;
}

async function seedCheckpointBase(h: TestApp): Promise<CkSeeded> {
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
      email: "ck-member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ck",
      lastName: "Member",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "ck-proj" })
    .returning();

  await h.db
    .insert(projectMembers)
    .values({ userId: member!.id, projectId: project!.id });

  const [build] = await h.db
    .insert(builds)
    .values({ projectId: project!.id, userId: member!.id, isRunning: true })
    .returning();

  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: build!.id,
      projectId: project!.id,
      name: "ck-run",
      branchName: "main",
      status: "running",
    })
    .returning();

  return {
    memberId: member!.id,
    memberJwt: h.app.jwt.sign({ sub: member!.id, role: "editor" }),
    projectId: project!.id,
    buildId: build!.id,
    runId: run!.id,
  };
}

d("POST /runs/:id/screenshots checkpoint tests (ADR-038)", () => {
  let h: TestApp;
  let port: number;
  let s: CkSeeded;

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
    s = await seedCheckpointBase(h);
  });

  test("POST screenshots with name + viewport + regions succeeds; checkpointId/testVariationId returned; checkpoint_count increments", async () => {
    const form = new FormData();
    form.append("name", "hero-section");
    form.append("viewport", "1280x720");
    form.append("browser", "chromium");
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
    const body = (await res.json()) as {
      screenshotId: string;
      checkpointId: string;
      testVariationId: string;
    };
    expect(body.screenshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.checkpointId).toBe(body.screenshotId);
    expect(body.testVariationId).toMatch(/^[0-9a-f-]{36}$/);

    // checkpoint_count incremented on the run
    const runRow = await h.db
      .select({ checkpointCount: testRuns.checkpointCount })
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(runRow[0]?.checkpointCount).toBe(1);

    // testVariation was created
    const varRow = await h.db
      .select()
      .from(testVariations)
      .where(eq(testVariations.id, body.testVariationId))
      .limit(1);
    expect(varRow[0]).toBeDefined();
    expect(varRow[0]!.name).toBe("hero-section");
    expect(varRow[0]!.viewport).toBe("1280x720");
    expect(varRow[0]!.browser).toBe("chromium");
  });

  test("duplicate (runId, name, viewport) returns 200 with same checkpoint (idempotent)", async () => {
    const uploadOnce = async () => {
      const form = new FormData();
      form.append("name", "dup-test");
      form.append("viewport", "1280x720");
      form.append("browser", "chromium");
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
      return res;
    };

    const first = await uploadOnce();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { screenshotId: string };

    const second = await uploadOnce();
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { screenshotId: string };

    // idempotent: same checkpoint returned
    expect(secondBody.screenshotId).toBe(firstBody.screenshotId);

    // checkpoint_count should only be 1 (not incremented on duplicate)
    const runRow = await h.db
      .select({ checkpointCount: testRuns.checkpointCount })
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(runRow[0]?.checkpointCount).toBe(1);
  });

  test("two checkpoints with different names share the same run row", async () => {
    const upload = async (name: string) => {
      const form = new FormData();
      form.append("name", name);
      form.append("viewport", "1280x720");
      form.append("browser", "chromium");
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
      return res.json() as Promise<{
        screenshotId: string;
        testVariationId: string;
      }>;
    };

    const a = await upload("header");
    const b = await upload("footer");

    expect(a.screenshotId).not.toBe(b.screenshotId);
    expect(a.testVariationId).not.toBe(b.testVariationId);

    // Both screenshots belong to the same run
    const rows = await h.db
      .select({ runId: screenshots.runId })
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(rows.length).toBe(2);

    // checkpoint_count is 2
    const runRow = await h.db
      .select({ checkpointCount: testRuns.checkpointCount })
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(runRow[0]?.checkpointCount).toBe(2);
  });

  test("POST screenshots without pngBytes → 400", async () => {
    const form = new FormData();
    form.append("name", "no-image");
    form.append("viewport", "1280x720");
    form.append("browser", "chromium");

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

  describe("run status while a checkpoint has no verdict (R31)", () => {
    const upload = async (name: string): Promise<{ screenshotId: string }> => {
      const form = new FormData();
      form.append("name", name);
      form.append("viewport", "1280x720");
      form.append("browser", "chromium");
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
      return (await res.json()) as { screenshotId: string };
    };
    const runStatus = async (): Promise<string | undefined> =>
      (
        await h.db
          .select({ status: testRuns.status })
          .from(testRuns)
          .where(eq(testRuns.id, s.runId))
          .limit(1)
      )[0]?.status;
    /** What the diff pipeline leaves behind once it has settled a checkpoint. */
    const settle = async (
      screenshotId: string,
      status: "passed" | "aborted",
    ): Promise<void> => {
      await h.db
        .update(screenshots)
        .set({ verdict: "passed", verdictAt: new Date() })
        .where(eq(screenshots.id, screenshotId));
      await h.db
        .update(testRuns)
        .set({ status })
        .where(eq(testRuns.id, s.runId));
    };

    test("an uploaded checkpoint keeps a run whose other checkpoints all have verdicts running", async () => {
      // Step 1 is diffed and the run rolled up to passed before step 2 arrives
      // (the SDK uploads a multi-step test one step at a time).
      const first = await upload("step-1");
      await settle(first.screenshotId, "passed");
      expect(await runStatus()).toBe("passed");

      await upload("step-2");

      // Step 2 has no verdict yet, so an SDK poll must not read a final status.
      expect(await runStatus()).toBe("running");
    });

    test("the first checkpoint leaves a running run running", async () => {
      await upload("step-1");
      expect(await runStatus()).toBe("running");
    });

    test("an aborted run stays aborted when a checkpoint is uploaded", async () => {
      const first = await upload("step-1");
      await settle(first.screenshotId, "aborted");

      await upload("step-2");

      expect(await runStatus()).toBe("aborted");
    });

    test("a run-level override survives an uploaded checkpoint", async () => {
      const first = await upload("step-1");
      await settle(first.screenshotId, "passed");
      await h.db
        .update(testRuns)
        .set({ statusOverride: "failed", status: "failed" })
        .where(eq(testRuns.id, s.runId));

      await upload("step-2");

      expect(await runStatus()).toBe("failed");
    });
  });
});
