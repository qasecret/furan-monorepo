import type { AddressInfo } from "node:net";

import {
  auditLog,
  baselines,
  builds,
  diffRegions,
  eq,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

// ADR-060: Visual-AI provider credentials in `image_comparison_config` are
// write-only on every read path, and only admins may change provider /
// baseUrl / apiKey. Editors keep the rest of "project settings write".

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

const KEY = "sk-live-SECRET-ai-lockdown-0123456789"; // gitleaks:allow — fake test key
const vlmConfig = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      provider: "anthropic",
      model: "claude-x",
      temperature: 0.1,
      apiKey: KEY,
      ...extra,
    },
    null,
    2,
  );

interface Seeded {
  adminId: string;
  adminJwt: string;
  editorId: string;
  editorJwt: string;
  projectId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  await h.db.delete(auditLog);
  await h.db.delete(diffRegions);
  await h.db.delete(screenshots);
  await h.db.delete(baselines);
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [admin] = await h.db
    .insert(users)
    .values({
      email: "ai-admin@t.example",
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
      email: "ai-editor@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ed",
      lastName: "Itor",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [project] = await h.db
    .insert(projects)
    .values({
      name: "vlm-project",
      imageComparison: "vlm",
      imageComparisonConfig: vlmConfig(),
    })
    .returning();
  await h.db
    .insert(projectMembers)
    .values({ userId: editor.id, projectId: project.id });

  return {
    adminId: admin.id,
    adminJwt: h.app.jwt.sign({ sub: admin.id, role: "admin" }),
    editorId: editor.id,
    editorJwt: h.app.jwt.sign({ sub: editor.id, role: "editor" }),
    projectId: project.id,
  };
}

function client(baseUrl: string, jwt: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers: { authorization: `Bearer ${jwt}` },
      }),
    ],
  });
}

d("Visual-AI provider settings lockdown (ADR-060)", () => {
  let h: TestApp;
  let baseUrl: string;
  let s: Seeded;

  const storedConfig = async () => {
    const [row] = await h.db
      .select({ c: projects.imageComparisonConfig })
      .from(projects)
      .where(eq(projects.id, s.projectId));
    return JSON.parse(row!.c) as Record<string, unknown>;
  };

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  describe("no read path returns the API key", () => {
    it.each(["admin", "editor"] as const)(
      "tRPC projects.getById as %s",
      async (who) => {
        const jwt = who === "admin" ? s.adminJwt : s.editorJwt;
        const p = await client(baseUrl, jwt).projects.getById.query({
          projectId: s.projectId,
        });
        expect(JSON.stringify(p)).not.toContain(KEY);
        expect(p.hasVlmApiKey).toBe(true);
        expect(JSON.parse(p.imageComparisonConfig)).toMatchObject({
          provider: "anthropic",
          model: "claude-x",
        });
      },
    );

    it("tRPC projects.update return value", async () => {
      const p = await client(baseUrl, s.adminJwt).projects.update.mutate({
        projectId: s.projectId,
        name: "renamed",
      });
      expect(JSON.stringify(p)).not.toContain(KEY);
      expect(p.hasVlmApiKey).toBe(true);
    });

    it.each(["/projects", "/projects/:id"])("REST GET %s", async (path) => {
      for (const jwt of [s.adminJwt, s.editorJwt]) {
        const res = await h.app.inject({
          method: "GET",
          url: path.replace(":id", s.projectId),
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(KEY);
        const body = JSON.parse(res.body);
        const row = Array.isArray(body) ? body[0] : body;
        expect(row.hasVlmApiKey).toBe(true);
      }
    });
  });

  describe("editors keep ordinary settings write", () => {
    it("can round-trip the redacted config with a knob change; the stored key survives", async () => {
      const api = client(baseUrl, s.editorJwt);
      const current = await api.projects.getById.query({
        projectId: s.projectId,
      });
      const edited = JSON.parse(current.imageComparisonConfig);
      edited.temperature = 0.4;
      edited.model = "claude-y";
      await api.projects.update.mutate({
        projectId: s.projectId,
        imageComparisonConfig: JSON.stringify(edited),
        retentionDays: 30,
      });
      const stored = await storedConfig();
      expect(stored.apiKey).toBe(KEY);
      expect(stored.temperature).toBe(0.4);
      expect(stored.model).toBe("claude-y");
    });
  });

  describe("provider settings are admin-only", () => {
    it.each([
      ["provider", { provider: "gemini" }],
      ["baseUrl", { baseUrl: "http://exfil.example:11434" }],
      ["apiKey (replace)", { apiKey: "sk-attacker" }],
      ["apiKey (clear)", { apiKey: "" }],
    ])("editor changing %s → FORBIDDEN, nothing written", async (_l, extra) => {
      const before = await storedConfig();
      const err = await client(baseUrl, s.editorJwt)
        .projects.update.mutate({
          projectId: s.projectId,
          imageComparisonConfig: vlmConfig(extra),
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCClientError);
      expect((err as TRPCClientError<AppRouter>).data?.code).toBe("FORBIDDEN");
      expect((err as Error).message).toBe("vlm_provider_settings_admin_only");
      expect(await storedConfig()).toEqual(before);
    });

    it("editor wiping the whole config (which drops the key) → FORBIDDEN", async () => {
      const err = await client(baseUrl, s.editorJwt)
        .projects.update.mutate({
          projectId: s.projectId,
          imageComparisonConfig: "",
        })
        .catch((e: unknown) => e);
      expect((err as TRPCClientError<AppRouter>).data?.code).toBe("FORBIDDEN");
      expect((await storedConfig()).apiKey).toBe(KEY);
    });

    it("admin can replace and then clear the key", async () => {
      const api = client(baseUrl, s.adminJwt);
      await api.projects.update.mutate({
        projectId: s.projectId,
        imageComparisonConfig: vlmConfig({ apiKey: "sk-rotated" }),
      });
      expect((await storedConfig()).apiKey).toBe("sk-rotated");
      const after = await api.projects.update.mutate({
        projectId: s.projectId,
        imageComparisonConfig: vlmConfig({ apiKey: "" }),
      });
      expect(await storedConfig()).not.toHaveProperty("apiKey");
      expect(after.hasVlmApiKey).toBe(false);
    });
  });

  it("rejects a config that isn't a JSON object or empty", async () => {
    const err = await client(baseUrl, s.adminJwt)
      .projects.update.mutate({
        projectId: s.projectId,
        imageComparisonConfig: "{not json",
      })
      .catch((e: unknown) => e);
    expect((err as TRPCClientError<AppRouter>).data?.code).toBe("BAD_REQUEST");
    expect((await storedConfig()).apiKey).toBe(KEY);
  });

  describe("projects.update is audited", () => {
    it("records changed fields + config sub-keys, never the key value", async () => {
      await client(baseUrl, s.adminJwt).projects.update.mutate({
        projectId: s.projectId,
        retentionDays: 7,
        imageComparisonConfig: vlmConfig({ apiKey: "sk-rotated", model: "m2" }),
      });
      const rows = await h.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, s.projectId));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.action).toBe("project.updated");
      expect(row.targetType).toBe("project");
      expect(row.actorId).toBe(s.adminId);
      expect(row.metadata).toMatchObject({
        fields: expect.arrayContaining([
          "retentionDays",
          "imageComparisonConfig",
        ]),
        changes: { retentionDays: { from: 90, to: 7 } },
        imageComparisonConfig: {
          changedKeys: ["apiKey", "model"],
          apiKey: "replaced",
          providerSettingsChanged: true,
        },
      });
      const serialized = JSON.stringify(row.metadata);
      expect(serialized).not.toContain(KEY);
      expect(serialized).not.toContain("sk-rotated");
    });

    it("writes no audit row for a no-op update", async () => {
      await client(baseUrl, s.adminJwt).projects.update.mutate({
        projectId: s.projectId,
        name: "vlm-project",
      });
      const rows = await h.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, s.projectId));
      expect(rows).toHaveLength(0);
    });
  });
});
