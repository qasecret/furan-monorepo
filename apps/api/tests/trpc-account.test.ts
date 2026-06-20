import type { AddressInfo } from "node:net";

import {
  diffRegions,
  projectMembers,
  projects,
  runReviewerDecisions,
  screenshots,
  testRuns,
  testVariations,
  builds,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

const d = !process.env.DATABASE_URL ? describe.skip : describe;

d("account.setDefaultProject", () => {
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
    await h.db.delete(diffRegions);
    await h.db.delete(screenshots);
    await h.db.delete(runReviewerDecisions);
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

  test("setDefaultProject persists for a member and surfaces on /users/me", async () => {
    await wipe();
    const [user] = await h.db
      .insert(users)
      .values({
        email: "acc-editor@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Ac",
        lastName: "Ct",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user");
    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });
    const [project] = await h.db
      .insert(projects)
      .values({ name: "acc-p1" })
      .returning();
    if (!project) throw new Error("project");
    await h.db
      .insert(projectMembers)
      .values({ userId: user.id, projectId: project.id });

    await makeClient(jwt).account.setDefaultProject.mutate({
      projectId: project.id,
    });

    const res = await h.app.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.json().defaultProjectId).toBe(project.id);
  });

  test("setDefaultProject rejects a non-member project (FORBIDDEN)", async () => {
    await wipe();
    const [user] = await h.db
      .insert(users)
      .values({
        email: "acc-nomember@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "No",
        lastName: "Mem",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user");
    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });
    const [project] = await h.db
      .insert(projects)
      .values({ name: "acc-foreign" })
      .returning();
    if (!project) throw new Error("project");

    await expect(
      makeClient(jwt).account.setDefaultProject.mutate({
        projectId: project.id,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/FORBIDDEN|forbidden/i),
    });
  });
});
