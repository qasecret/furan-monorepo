import type { AddressInfo } from "node:net";

import {
  dashboardTelemetryEvents,
  projectMembers,
  projects,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

const d = !process.env.DATABASE_URL ? describe.skip : describe;

d("trpc analytics", () => {
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

  async function wipe() {
    await h.db.delete(dashboardTelemetryEvents);
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

  async function seedAdmin(emailSuffix: string) {
    const [admin] = await h.db
      .insert(users)
      .values({
        email: `analytics-admin-${emailSuffix}@t.example`,
        hashedPassword: await hashPassword("x"),
        firstName: "Ad",
        lastName: "Min",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");
    return admin;
  }

  async function seedUser(
    emailSuffix: string,
    role: "editor" | "guest" = "editor",
  ) {
    const [user] = await h.db
      .insert(users)
      .values({
        email: `analytics-user-${emailSuffix}@t.example`,
        hashedPassword: await hashPassword("x"),
        firstName: "Us",
        lastName: "Er",
        role,
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");
    return user;
  }

  test("summary aggregates counts + ratios + median across the window", async () => {
    // Seed: admin + 6 telemetry events:
    //   3x inbox.row_action: 2 approve (1 keyboard), 1 reject (mouse)
    //   3x inbox.session_duration with actionsTaken=3, durations 9000/15000/30000 ms
    //     -> per-action ms: 3000 / 5000 / 10000 -> median 5000
    //   3x inbox.viewed (ignored by the action aggregator)
    // Expect totalActions=3, approves=2, rejects=1, viaKeyboard=1,
    // medianMsPerAction=5000, approveRate ≈ 0.667, keyboardRate ≈ 0.333.
    await wipe();

    const admin = await seedAdmin("summary");
    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    // 3x inbox.row_action
    await h.db.insert(dashboardTelemetryEvents).values([
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "approve", viaKeyboard: true },
      },
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "approve", viaKeyboard: false },
      },
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "reject", viaKeyboard: false },
      },
    ]);

    // 3x inbox.session_duration with actionsTaken=3, durations 9000/15000/30000 ms
    // per-action ms: 9000/3=3000, 15000/3=5000, 30000/3=10000 → median 5000
    await h.db.insert(dashboardTelemetryEvents).values([
      {
        userId: admin.id,
        event: "inbox.session_duration",
        props: { durationMs: 9000, actionsTaken: 3 },
      },
      {
        userId: admin.id,
        event: "inbox.session_duration",
        props: { durationMs: 15000, actionsTaken: 3 },
      },
      {
        userId: admin.id,
        event: "inbox.session_duration",
        props: { durationMs: 30000, actionsTaken: 3 },
      },
    ]);

    // 3x inbox.viewed (ignored by the action aggregator)
    await h.db.insert(dashboardTelemetryEvents).values([
      { userId: admin.id, event: "inbox.viewed", props: {} },
      { userId: admin.id, event: "inbox.viewed", props: {} },
      { userId: admin.id, event: "inbox.viewed", props: {} },
    ]);

    const caller = makeClient(adminJwt);
    const result = await caller.analytics.summary.query({ days: 7 });

    expect(result.totalActions).toBe(3);
    expect(result.approves).toBe(2);
    expect(result.rejects).toBe(1);
    expect(result.viaKeyboard).toBe(1);
    expect(result.sessions).toBe(3);
    expect(result.medianMsPerAction).toBe(5000);
    expect(result.approveRate).toBeCloseTo(2 / 3);
    expect(result.rejectRate).toBeCloseTo(1 / 3);
    expect(result.keyboardRate).toBeCloseTo(1 / 3);
  });

  test("actionsByDay buckets by day with approve/reject split", async () => {
    // Seed: 3 row_action events on day D-2 (2 approve), 2 on day D-1 (1 each), 1 today (1 reject).
    // Expect 3 buckets in chronological order with the right counts.
    await wipe();

    const admin = await seedAdmin("actions-by-day");
    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    const now = new Date();
    const dMinus2 = new Date(now);
    dMinus2.setDate(now.getDate() - 2);
    const dMinus1 = new Date(now);
    dMinus1.setDate(now.getDate() - 1);

    await h.db.insert(dashboardTelemetryEvents).values([
      // Day D-2: 2 approve
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "approve" },
        createdAt: dMinus2,
      },
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "approve" },
        createdAt: dMinus2,
      },
      // Day D-1: 1 approve + 1 reject
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "approve" },
        createdAt: dMinus1,
      },
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "reject" },
        createdAt: dMinus1,
      },
      // Today: 1 reject
      {
        userId: admin.id,
        event: "inbox.row_action",
        props: { action: "reject" },
        createdAt: now,
      },
    ]);

    const caller = makeClient(adminJwt);
    const result = await caller.analytics.actionsByDay.query({ days: 7 });

    expect(result.items.length).toBe(3);
    // chronological order: D-2 first
    expect(result.items[0]!.approves).toBe(2);
    expect(result.items[0]!.rejects).toBe(0);
    expect(result.items[1]!.approves).toBe(1);
    expect(result.items[1]!.rejects).toBe(1);
    expect(result.items[2]!.approves).toBe(0);
    expect(result.items[2]!.rejects).toBe(1);
  });

  test("topReviewers excludes null-user events and orders by count DESC", async () => {
    // Seed: 5 events for user A, 3 for user B, 1 for null (auto/system), 2 for user C.
    // Expect items=[A:5, B:3, C:2], no null entry.
    await wipe();

    const admin = await seedAdmin("top-rev-admin");
    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    const userA = await seedUser("top-rev-a");
    const userB = await seedUser("top-rev-b");
    const userC = await seedUser("top-rev-c");

    // 5 actions for userA
    for (let i = 0; i < 5; i++) {
      await h.db.insert(dashboardTelemetryEvents).values({
        userId: userA.id,
        event: "inbox.row_action",
        props: { action: "approve" },
      });
    }
    // 3 actions for userB
    for (let i = 0; i < 3; i++) {
      await h.db.insert(dashboardTelemetryEvents).values({
        userId: userB.id,
        event: "inbox.row_action",
        props: { action: "approve" },
      });
    }
    // 1 action with null userId (auto/system)
    await h.db.insert(dashboardTelemetryEvents).values({
      userId: null,
      event: "inbox.row_action",
      props: { action: "approve" },
    });
    // 2 actions for userC
    for (let i = 0; i < 2; i++) {
      await h.db.insert(dashboardTelemetryEvents).values({
        userId: userC.id,
        event: "inbox.row_action",
        props: { action: "approve" },
      });
    }

    const caller = makeClient(adminJwt);
    const result = await caller.analytics.topReviewers.query({
      days: 7,
      limit: 10,
    });

    // No null entry
    expect(result.items.every((i) => i.userId !== null)).toBe(true);
    // Ordered DESC by actions
    expect(result.items[0]!.actions).toBe(5);
    expect(result.items[1]!.actions).toBe(3);
    expect(result.items[2]!.actions).toBe(2);
    expect(result.items).toHaveLength(3);
  });

  test("non-admin gets FORBIDDEN", async () => {
    await wipe();

    const user = await seedUser("non-admin-forbidden");
    const userJwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const caller = makeClient(userJwt);

    await expect(
      caller.analytics.summary.query({ days: 7 }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});
