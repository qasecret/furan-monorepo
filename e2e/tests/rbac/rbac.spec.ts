import { expect, test } from "@playwright/test";

import { ApiClient, type Role } from "../../src/clients/api-client.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { loadSeed, principal } from "../../src/seed/load-seed.js";
import type { SeededPrincipal, SeedResult } from "../../src/seed/seed.js";


/**
 * RBAC gates via the seeded owner/admin/editor/guest principals. `GET /users`
 * is the admin-gated surface; a build on `alpha` is the member-scoped surface
 * (the editor is a member of alpha from seeding).
 */
test.describe.serial("rbac", () => {
  const api = new ApiClient(API);
  let admin = "";
  let seed: SeedResult;
  let alphaId = "";
  const byRole = (r: Role): SeededPrincipal => principal(seed, r);

  test.beforeAll(() => {
    seed = loadSeed();
    admin = seed.bootstrapAdminJwt;
    const alpha = seed.projects.find((p) => p.name === "alpha");
    if (!alpha) throw new Error("alpha project not seeded");
    alphaId = alpha.id;
  });

  test("owner + admin pass the admin gate; editor + guest are blocked", async ({}, testInfo) => {
    testInfo.annotations.push(
      ...coverAnnotations(["rbac.owner_all_gates", "rbac.guest_rejected"]),
    );
    expect((await api.probe("GET", "/users", { auth: byRole("owner").pat })).status).toBe(200);
    expect((await api.probe("GET", "/users", { auth: byRole("admin").pat })).status).toBe(200);
    expect((await api.probe("GET", "/users", { auth: byRole("editor").pat })).status).toBe(403);
    expect((await api.probe("GET", "/users", { auth: byRole("guest").pat })).status).toBe(403);
  });

  test("editor is allowed on a project it is a member of", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["rbac.editor_scoped"]));
    const res = await api.probe("POST", `/projects/${alphaId}/builds`, {
      auth: byRole("editor").pat,
      body: { branchName: "main", name: "rbac-editor-build" },
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  test("JWT and PAT both authenticate", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["rbac.jwt_and_pat"]));
    const owner = byRole("owner");
    expect((await api.probe("GET", "/users/me", { auth: owner.jwt })).status).toBe(200);
    expect((await api.probe("GET", "/users/me", { auth: owner.pat })).status).toBe(200);
  });

  test("deactivation takes effect on the next request", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["rbac.deactivation"]));
    const editor = byRole("editor");
    try {
      await api.updateUser(admin, editor.id, { isActive: false });
      // JWT path: the live user resolves but is inactive → 403 account_inactive.
      const viaJwt = await api.probe("GET", "/users/me", { auth: editor.jwt });
      expect(viaJwt.status).toBe(403);
      expect(viaJwt.body).toMatchObject({ code: "account_inactive" });
      // PAT path: loadActiveUserByPat filters isActive, so the token no longer
      // resolves → 401 invalid_token. Both prove deactivation is immediate.
      const viaPat = await api.probe("GET", "/users/me", { auth: editor.pat });
      expect(viaPat.status).toBe(401);
    } finally {
      // Always restore so a mid-test failure can't leave the editor disabled.
      await api.updateUser(admin, editor.id, { isActive: true });
    }
  });

  test("separation-of-duties invariants are enforced", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["rbac.sod"]));
    const owner = byRole("owner");
    // A non-owner (admin) cannot deactivate an owner → owner_protected (403).
    const protectedRes = await api.probe("PATCH", `/users/${owner.id}`, {
      auth: admin,
      body: { isActive: false },
    });
    expect(protectedRes.status).toBe(403);
    expect(protectedRes.body).toMatchObject({ code: "owner_protected" });
    // Nobody can change their OWN role → cannot_change_own_role (400). This
    // fires before the last_owner check, so it's the reachable self-service SoD
    // guard for the sole owner.
    const ownRole = await api.probe("PATCH", `/users/${owner.id}`, {
      auth: owner.jwt,
      body: { role: "admin" },
    });
    expect(ownRole.status).toBe(400);
    expect(ownRole.body).toMatchObject({ code: "cannot_change_own_role" });
  });
});
