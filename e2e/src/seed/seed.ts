import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  API_URL,
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_PASSWORD,
  USER_PASSWORD,
} from "../../scripts/compose.js";
import { ApiClient, ApiError, type Role } from "../clients/api-client.js";

/**
 * Seed the running deployment with RBAC principals + projects the tests need,
 * via the real admin API (the images are distroless — no CLI exec). Idempotent:
 * "already exists" (409) is recovered by looking the entity up, so re-seeding a
 * kept-alive stack is safe.
 */
export interface SeededPrincipal {
  email: string;
  role: Role;
  id: string;
  pat: string;
  jwt: string;
}

export interface SeedResult {
  bootstrapAdminJwt: string;
  principals: SeededPrincipal[];
  projects: { name: string; id: string }[];
}

const ROLES: { role: Role; email: string; first: string; last: string }[] = [
  { role: "owner", email: "e2e-owner@furan.test", first: "Ovie", last: "Owner" },
  { role: "admin", email: "e2e-admin2@furan.test", first: "Adah", last: "Admin" },
  { role: "editor", email: "e2e-editor@furan.test", first: "Edie", last: "Editor" },
  { role: "guest", email: "e2e-guest@furan.test", first: "Gus", last: "Guest" },
];

const SEED_FILE = fileURLToPath(new URL("../../.seed.json", import.meta.url));

export async function seedAll(): Promise<SeedResult> {
  const api = new ApiClient(API_URL);

  const boot = await api.loginJwt(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
  const admin = boot.token;

  const principals: SeededPrincipal[] = [];
  for (const spec of ROLES) {
    let id: string;
    try {
      const created = await api.createUser(admin, {
        email: spec.email,
        password: USER_PASSWORD,
        firstName: spec.first,
        lastName: spec.last,
        role: spec.role,
      });
      id = created.id;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const existing = (await api.listUsers(admin)).find(
          (u) => u.email === spec.email,
        );
        if (!existing) throw e;
        id = existing.id;
      } else {
        throw e;
      }
    }
    const login = await api.loginJwt(spec.email, USER_PASSWORD);
    const pat = await api.mintPat(login.token, `e2e-${spec.role}`);
    principals.push({ email: spec.email, role: spec.role, id, pat, jwt: login.token });
  }

  const projects: { name: string; id: string }[] = [];
  for (const name of ["alpha", "beta"]) {
    try {
      const p = await api.createProject(admin, { name });
      projects.push({ name, id: p.id });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const p = (await api.listProjects(admin)).find((x) => x.name === name);
        if (!p) throw e;
        projects.push({ name, id: p.id });
      } else {
        throw e;
      }
    }
  }

  // Editor is a member of alpha (for the "editor allowed on member project" gate).
  const editor = principals.find((p) => p.role === "editor");
  const alpha = projects.find((p) => p.name === "alpha");
  if (editor && alpha) await api.addMember(admin, alpha.id, editor.id);

  const result: SeedResult = {
    bootstrapAdminJwt: admin,
    principals,
    projects,
  };
  writeFileSync(SEED_FILE, JSON.stringify(result, null, 2));
  return result;
}
