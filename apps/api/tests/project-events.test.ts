import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  diffRegions,
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

/**
 * Smoke tests for the project-scoped SSE route. We test the connection
 * surface — status code, CORS allowlist mirroring, auth gates — but
 * NOT the full Redis pub/sub fanout in here: that's heavy fixture-side
 * coordination and node 20's fetch + AbortController has known stream
 * buffering quirks. The pub/sub side is covered by:
 *
 *   - apps/api/tests/broadcast.test.ts (broadcaster unit, JSON wire shape)
 *   - apps/api/tests/broadcast-wiring.test.ts (each producer fires the
 *     right event by asserting on the broadcaster mock)
 *   - the existing per-run SSE pattern (apps/api/src/routes/run-events.ts
 *     + run-events.test.ts) which the project route clones structurally
 *
 * Live end-to-end verification happens in the post-merge QA pass with
 * the actual dashboard subscriber attached.
 */

const skip = !process.env.DATABASE_URL || !process.env.REDIS_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  memberJwt: string;
  nonMemberJwt: string;
  projectId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  await h.db.delete(diffRegions);
  await h.db.delete(baselines);
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
      email: "psse-member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "M",
      lastName: "B",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [nonMember] = await h.db
    .insert(users)
    .values({
      email: "psse-nonmember@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "N",
      lastName: "M",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [project] = await h.db
    .insert(projects)
    .values({ name: "psse-project" })
    .returning();
  await h.db
    .insert(projectMembers)
    .values({ userId: member.id, projectId: project.id });

  return {
    memberJwt: h.app.jwt.sign({ sub: member.id, role: "editor" }),
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember.id, role: "editor" }),
    projectId: project.id,
  };
}

interface SseHead {
  code: number;
  contentType: string;
  allowOrigin: string | undefined;
  allowCredentials: string | undefined;
  vary: string | undefined;
}

/**
 * Open a connection, read response headers, destroy. Mirrors the
 * existing run-events test pattern at apps/api/tests/run-events.test.ts.
 */
function readSseHead(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<SseHead> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, headers },
      (res) => {
        resolve({
          code: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          allowOrigin: res.headers["access-control-allow-origin"] as
            | string
            | undefined,
          allowCredentials: res.headers["access-control-allow-credentials"] as
            | string
            | undefined,
          vary: res.headers["vary"] as string | undefined,
        });
        res.destroy();
        req.destroy();
      },
    );
    req.on("error", reject);
    req.end();
  });
}

d("GET /api/v1/projects/:id/events (SSE smoke)", () => {
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

  test("returns 200 + text/event-stream for member", async () => {
    const r = await readSseHead(
      port,
      `/api/v1/projects/${s.projectId}/events`,
      {
        authorization: `Bearer ${s.memberJwt}`,
        accept: "text/event-stream",
      },
    );
    expect(r.code).toBe(200);
    expect(r.contentType).toMatch(/text\/event-stream/);
  });

  test("returns 403 for non-member", async () => {
    const r = await readSseHead(
      port,
      `/api/v1/projects/${s.projectId}/events`,
      {
        authorization: `Bearer ${s.nonMemberJwt}`,
        accept: "text/event-stream",
      },
    );
    expect(r.code).toBe(403);
  });

  test("mirrors CORS Allow-Origin when request origin is allowlisted", async () => {
    const r = await readSseHead(
      port,
      `/api/v1/projects/${s.projectId}/events`,
      {
        authorization: `Bearer ${s.memberJwt}`,
        accept: "text/event-stream",
        origin: "http://localhost:3001",
      },
    );
    expect(r.allowOrigin).toBe("http://localhost:3001");
    expect(r.allowCredentials).toBe("true");
    expect(r.vary).toContain("Origin");
  });

  test("does NOT echo Allow-Origin for disallowed origin", async () => {
    const r = await readSseHead(
      port,
      `/api/v1/projects/${s.projectId}/events`,
      {
        authorization: `Bearer ${s.memberJwt}`,
        accept: "text/event-stream",
        origin: "https://evil.example.com",
      },
    );
    expect(r.allowOrigin).toBeUndefined();
  });
});
