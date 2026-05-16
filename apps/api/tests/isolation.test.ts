import { builds, projectMembers, projects, users } from "@furan/db";
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

describe("project-isolation matrix", () => {
  let h: TestApp;
  let adminJwt: string;
  let aliceJwt: string;
  let bobJwt: string;
  let guestJwt: string;
  let aliceId: string;
  let bobId: string;
  let projectAId: string;
  let projectBId: string;

  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    // FK-order: dependents before parents.
    await h.db.delete(builds);
    await h.db.delete(projectMembers);
    await h.db.delete(projects);
    await h.db.delete(users);

    const seedUser = async (
      email: string,
      role: "admin" | "editor" | "guest",
    ): Promise<string> => {
      const [u] = await h.db
        .insert(users)
        .values({
          email,
          hashedPassword: await hashPassword("x"),
          firstName: email,
          lastName: "x",
          role,
          isActive: true,
        })
        .returning();
      return u.id;
    };

    const adminId = await seedUser("admin@t.example", "admin");
    aliceId = await seedUser("alice@t.example", "editor");
    bobId = await seedUser("bob@t.example", "editor");
    const guestId = await seedUser("guest@t.example", "guest");

    adminJwt = h.app.jwt.sign({ sub: adminId, role: "admin" });
    aliceJwt = h.app.jwt.sign({ sub: aliceId, role: "editor" });
    bobJwt = h.app.jwt.sign({ sub: bobId, role: "editor" });
    guestJwt = h.app.jwt.sign({ sub: guestId, role: "guest" });

    const [pA] = await h.db
      .insert(projects)
      .values({ name: "alpha" })
      .returning();
    const [pB] = await h.db
      .insert(projects)
      .values({ name: "beta" })
      .returning();
    projectAId = pA.id;
    projectBId = pB.id;

    await h.db
      .insert(projectMembers)
      .values({ userId: aliceId, projectId: projectAId });
    await h.db
      .insert(projectMembers)
      .values({ userId: bobId, projectId: projectBId });

    await h.db
      .insert(builds)
      .values({ projectId: projectAId, isRunning: true });
    await h.db
      .insert(builds)
      .values({ projectId: projectBId, isRunning: true });
  });

  const auth = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  test("1. GET /projects/:idA as admin -> 200", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectAId}`,
      headers: auth(adminJwt),
    });
    expect(res.statusCode).toBe(200);
  });

  test("2. GET /projects/:idA as editor member -> 200", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectAId}`,
      headers: auth(aliceJwt),
    });
    expect(res.statusCode).toBe(200);
  });

  test("3. GET /projects/:idA as editor non-member -> 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectAId}`,
      headers: auth(bobJwt),
    });
    expect(res.statusCode).toBe(403);
  });

  test("4. GET /projects/:idA as guest -> 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectAId}`,
      headers: auth(guestJwt),
    });
    expect(res.statusCode).toBe(403);
  });

  test("5. GET /projects/:idA unauthenticated -> 401", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectAId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("6. GET /projects as admin -> all", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: auth(adminJwt),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  test("7. GET /projects as editor -> only member-of", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: auth(aliceJwt),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string }>;
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(projectAId);
  });

  test("8. GET /projects as guest -> []", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: auth(guestJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  test("9. POST /projects as editor -> 403", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/projects",
      headers: auth(aliceJwt),
      payload: { name: "gamma" },
    });
    expect(res.statusCode).toBe(403);
  });

  test("10. POST /projects as admin -> 201", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/projects",
      headers: auth(adminJwt),
      payload: { name: "gamma" },
    });
    expect(res.statusCode).toBe(201);
  });

  test("11. POST /projects/:idA/members as editor -> 403", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${projectAId}/members`,
      headers: auth(aliceJwt),
      payload: { userId: bobId },
    });
    expect(res.statusCode).toBe(403);
  });

  test("12. POST /projects/:idA/members as admin -> 201", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${projectAId}/members`,
      headers: auth(adminJwt),
      payload: { userId: bobId },
    });
    expect(res.statusCode).toBe(201);
  });

  test("13. DELETE /projects/:idA/members/:aliceId as alice -> 403", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: `/projects/${projectAId}/members/${aliceId}`,
      headers: auth(aliceJwt),
    });
    expect(res.statusCode).toBe(403);
  });

  test("14. GET /projects/:idA/builds as bob (non-member) -> 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectAId}/builds`,
      headers: auth(bobJwt),
    });
    expect(res.statusCode).toBe(403);
  });

  test("15. GET /projects/:idA/builds as alice (member) -> 200 + 1 build", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectAId}/builds`,
      headers: auth(aliceJwt),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(1);
  });

  test("16. POST /projects/:idA/builds as bob -> 403", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${projectAId}/builds`,
      headers: auth(bobJwt),
      payload: { branchName: "feat/x" },
    });
    expect(res.statusCode).toBe(403);
  });

  test("17. POST /projects/:idA/builds as alice -> 201", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${projectAId}/builds`,
      headers: auth(aliceJwt),
      payload: { branchName: "feat/x" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { isRunning: boolean; projectId: string };
    expect(body.isRunning).toBe(true);
    expect(body.projectId).toBe(projectAId);
  });

  test("18. GET /projects/:idB/builds as alice (not member of B) -> 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${projectBId}/builds`,
      headers: auth(aliceJwt),
    });
    expect(res.statusCode).toBe(403);
  });

  test("19. GET /users as admin -> 200", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: auth(adminJwt),
    });
    expect(res.statusCode).toBe(200);
  });

  test("20. GET /users as editor -> 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: auth(aliceJwt),
    });
    expect(res.statusCode).toBe(403);
  });

  test("21. GET /users as guest -> 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: auth(guestJwt),
    });
    expect(res.statusCode).toBe(403);
  });
});
