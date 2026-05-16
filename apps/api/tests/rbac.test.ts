import { projectMembers, projects, users } from "@furan/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { requireProjectMember } from "../src/hooks/require-project-member.js";
import { requireRole } from "../src/hooks/require-role.js";
import { hashPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

describe("RBAC hooks", () => {
  let h: TestApp;
  let adminJwt: string;
  let editorJwt: string;
  let guestJwt: string;
  let memberProjectId: string;
  let nonMemberProjectId: string;

  beforeAll(async () => {
    h = await createTestApp({ skipReady: true });
    // Register probe routes exercising each hook.
    h.app.get(
      "/_test/admin-only",
      { preHandler: [h.app.authenticate, requireRole("admin")] },
      async () => ({ ok: true }),
    );
    h.app.get(
      "/_test/project/:id",
      {
        preHandler: [
          h.app.authenticate,
          requireProjectMember("read", { from: { params: "id" } }),
        ],
      },
      async () => ({ ok: true }),
    );
    await h.app.ready();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    // FK-order: dependents before parents.
    await h.db.delete(projectMembers);
    await h.db.delete(projects);
    await h.db.delete(users);

    const [admin] = await h.db
      .insert(users)
      .values({
        email: "admin@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Ad",
        lastName: "Min",
        role: "admin",
        isActive: true,
      })
      .returning();
    const [editor] = await h.db
      .insert(users)
      .values({
        email: "editor@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Ed",
        lastName: "Itor",
        role: "editor",
        isActive: true,
      })
      .returning();
    const [guest] = await h.db
      .insert(users)
      .values({
        email: "guest@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "G",
        lastName: "U",
        role: "guest",
        isActive: true,
      })
      .returning();

    adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });
    editorJwt = h.app.jwt.sign({ sub: editor.id, role: "editor" });
    guestJwt = h.app.jwt.sign({ sub: guest.id, role: "guest" });

    const [pA] = await h.db
      .insert(projects)
      .values({ name: "alpha" })
      .returning();
    const [pB] = await h.db
      .insert(projects)
      .values({ name: "beta" })
      .returning();
    memberProjectId = pA.id;
    nonMemberProjectId = pB.id;

    await h.db.insert(projectMembers).values({
      userId: editor.id,
      projectId: memberProjectId,
    });
  });

  test("requireRole('admin'): admin 200", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/_test/admin-only",
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("requireRole('admin'): editor 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/_test/admin-only",
      headers: { authorization: `Bearer ${editorJwt}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("requireProjectMember: admin bypass", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/_test/project/${nonMemberProjectId}`,
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("requireProjectMember: editor member 200", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/_test/project/${memberProjectId}`,
      headers: { authorization: `Bearer ${editorJwt}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("requireProjectMember: editor non-member 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/_test/project/${nonMemberProjectId}`,
      headers: { authorization: `Bearer ${editorJwt}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("requireProjectMember: guest 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/_test/project/${memberProjectId}`,
      headers: { authorization: `Bearer ${guestJwt}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
