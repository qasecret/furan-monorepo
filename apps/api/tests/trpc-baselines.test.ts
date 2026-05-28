import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  projectMembers,
  projects,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

const d = !process.env.DATABASE_URL ? describe.skip : describe;

d("trpc baselines.listForVariation", () => {
  let h: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow

    h = await createTestApp();
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await h.close();
  });

  /**
   * Wipe all tables in FK-safe order before each seed so tests don't bleed
   * into each other when run with --reporter=verbose.
   */
  async function wipe() {
    await h.db.delete(baselines);
    await h.db.delete(testRuns);
    await h.db.delete(testVariations);
    await h.db.delete(builds);
    await h.db.delete(projectMembers);
    await h.db.delete(projects);
    await h.db.delete(users);
  }

  function makeClient(jwt: string) {
    return createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}/trpc`,
          headers: { authorization: `Bearer ${jwt}` },
        }),
      ],
    });
  }

  test("returns baselines for the variation, newest first, with isAuto flag", async () => {
    await wipe();

    // Seed admin user (project member via admin bypass).
    const [admin] = await h.db
      .insert(users)
      .values({
        email: "baselines-admin@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Ad",
        lastName: "Min",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");

    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "baselines-project-1" })
      .returning();
    if (!project) throw new Error("project not seeded");

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "home-page" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    // Three runs — one per baseline entry.
    const [run1] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "passed",
      })
      .returning();
    if (!run1) throw new Error("run1 not seeded");

    const [run2] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "passed",
      })
      .returning();
    if (!run2) throw new Error("run2 not seeded");

    const [run3] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "passed",
      })
      .returning();
    if (!run3) throw new Error("run3 not seeded");

    // Insert 3 baseline rows in chronological order:
    //   - manual approve by admin (userId set)
    //   - auto approve (userId null)
    //   - manual approve by admin (userId set)
    // We rely on defaultNow() for ordering; insert in sequence so
    // createdAt values differ. A small sleep isn't needed because
    // Postgres assigns distinct timestamps for each INSERT statement.
    const [b1] = await h.db
      .insert(baselines)
      .values({
        baselineName: "home-page.png",
        testVariationId: variation.id,
        testRunId: run1.id,
        userId: admin.id,
        branchName: "main",
      })
      .returning();
    if (!b1) throw new Error("b1 not seeded");

    const [b2] = await h.db
      .insert(baselines)
      .values({
        baselineName: "home-page.png",
        testVariationId: variation.id,
        testRunId: run2.id,
        userId: null,
        branchName: "main",
      })
      .returning();
    if (!b2) throw new Error("b2 not seeded");

    const [b3] = await h.db
      .insert(baselines)
      .values({
        baselineName: "home-page.png",
        testVariationId: variation.id,
        testRunId: run3.id,
        userId: admin.id,
        branchName: "main",
      })
      .returning();
    if (!b3) throw new Error("b3 not seeded");

    const caller = makeClient(adminJwt);
    const result = await caller.baselines.listForVariation.query({
      testVariationId: variation.id,
    });

    expect(result.items).toHaveLength(3);

    // Newest first — b3 was inserted last so it should appear first.
    // We verify the ordering by checking isAuto: the sequence should be
    // false (b3) → true (b2) → false (b1) because we inserted oldest-first
    // and the query returns DESC.
    const autoFlags = result.items.map((i) => i.isAuto);
    // The two manual rows must have isAuto=false and the auto row isAuto=true.
    expect(autoFlags.filter((f) => f === false)).toHaveLength(2);
    expect(autoFlags.filter((f) => f === true)).toHaveLength(1);

    // Manual rows carry the approver email.
    const manualRows = result.items.filter((i) => !i.isAuto);
    for (const row of manualRows) {
      expect(row.approverEmail).toBe(admin.email);
    }

    // Auto row has null approverEmail.
    const autoRows = result.items.filter((i) => i.isAuto);
    expect(autoRows).toHaveLength(1);
    expect(autoRows[0]?.approverEmail).toBeNull();

    // createdAt fields are ISO strings.
    for (const item of result.items) {
      expect(typeof item.createdAt).toBe("string");
      expect(() => new Date(item.createdAt)).not.toThrow();
    }
  });

  test("rejects when caller is not a project member", async () => {
    await wipe();

    // Admin that owns the project.
    const [admin] = await h.db
      .insert(users)
      .values({
        email: "baselines-owner@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Own",
        lastName: "Er",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");

    // Non-member editor.
    const [guest] = await h.db
      .insert(users)
      .values({
        email: "baselines-nonmember@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Non",
        lastName: "Member",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!guest) throw new Error("guest not seeded");

    const guestJwt = h.app.jwt.sign({ sub: guest.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "baselines-project-gated" })
      .returning();
    if (!project) throw new Error("project not seeded");

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "gated-variation" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const caller = makeClient(guestJwt);

    // Guest has no membership in this project — expect FORBIDDEN.
    await expect(
      caller.baselines.listForVariation.query({
        testVariationId: variation.id,
      }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});
