import http from "node:http";
import type { AddressInfo } from "node:net";

import { projectMembers, projects, users } from "@furan/db";
import { createRedisConnection } from "@furan/queue";
import { bootstrapTelemetry } from "@furan/telemetry";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { createBroadcaster } from "../src/lib/broadcast.js";
import { hashPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL || !process.env.REDIS_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  memberAbJwt: string; // member of A and B
  memberAJwt: string; // member of A only
  adminJwt: string;
  emptyJwt: string; // member of nothing
  unauthHeaders: Record<string, string>;
  projectAId: string;
  projectBId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const mk = async (email: string, role: "editor" | "admin") => {
    const [u] = await h.db
      .insert(users)
      .values({
        email,
        hashedPassword: await hashPassword("x"),
        firstName: "T",
        lastName: "U",
        role,
        isActive: true,
      })
      .returning();
    return u;
  };

  const memberAb = await mk("ie-ab@t.example", "editor");
  const memberA = await mk("ie-a@t.example", "editor");
  const admin = await mk("ie-admin@t.example", "admin");
  const empty = await mk("ie-empty@t.example", "editor");

  const [projA] = await h.db
    .insert(projects)
    .values({ name: "ie-project-a" })
    .returning();
  const [projB] = await h.db
    .insert(projects)
    .values({ name: "ie-project-b" })
    .returning();

  await h.db.insert(projectMembers).values([
    { userId: memberAb.id, projectId: projA.id },
    { userId: memberAb.id, projectId: projB.id },
    { userId: memberA.id, projectId: projA.id },
  ]);

  return {
    memberAbJwt: h.app.jwt.sign({ sub: memberAb.id, role: "editor" }),
    memberAJwt: h.app.jwt.sign({ sub: memberA.id, role: "editor" }),
    adminJwt: h.app.jwt.sign({ sub: admin.id, role: "admin" }),
    emptyJwt: h.app.jwt.sign({ sub: empty.id, role: "editor" }),
    unauthHeaders: { accept: "text/event-stream" },
    projectAId: projA.id,
    projectBId: projB.id,
  };
}

interface SseHead {
  code: number;
  contentType: string;
  allowOrigin: string | undefined;
}

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
        });
        res.destroy();
        req.destroy();
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Open an SSE stream, collect chunks, publish on channels, and return the
 * accumulated text after `waitMs`. Mirrors the project-events.test.ts
 * real-broadcaster forwarding pattern.
 */
function collectStream(opts: {
  port: number;
  jwt: string;
  publish: () => Promise<void>;
  waitMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: "/api/v1/events",
        headers: {
          authorization: `Bearer ${opts.jwt}`,
          accept: "text/event-stream",
        },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => chunks.push(c));
      },
    );
    req.on("error", reject);
    req.end();

    // Let headers + Redis subscribe settle, publish, then wait for the frame.
    setTimeout(() => {
      void opts.publish().then(() => {
        setTimeout(() => {
          req.destroy();
          resolve(chunks.join(""));
        }, opts.waitMs);
      });
    }, 300);
  });
}

d("GET /api/v1/events (multiplexed inbox SSE)", () => {
  let h: TestApp;
  let port: number;
  let s: Seeded;
  let redis: ReturnType<typeof createRedisConnection>;

  beforeAll(async () => {
    redis = createRedisConnection();
    const telemetry = bootstrapTelemetry({
      service: "inbox-events-test",
      version: "test",
    });
    const realBroadcaster = createBroadcaster(redis, telemetry);
    h = await createTestApp({ broadcaster: realBroadcaster });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    port = (h.app.server.address() as AddressInfo).port;
    const origClose = h.close;
    h.close = async () => {
      await origClose();
      redis.disconnect();
      await telemetry.shutdown();
    };
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  test("returns 200 + text/event-stream for an authed editor", async () => {
    const r = await readSseHead(port, "/api/v1/events", {
      authorization: `Bearer ${s.memberAbJwt}`,
      accept: "text/event-stream",
    });
    expect(r.code).toBe(200);
    expect(r.contentType).toMatch(/text\/event-stream/);
  });

  test("returns 401 for an unauthenticated request", async () => {
    const r = await readSseHead(port, "/api/v1/events", s.unauthHeaders);
    expect(r.code).toBe(401);
  });

  test("mirrors CORS Allow-Origin for an allowlisted origin", async () => {
    const r = await readSseHead(port, "/api/v1/events", {
      authorization: `Bearer ${s.memberAbJwt}`,
      accept: "text/event-stream",
      origin: "http://localhost:3001",
    });
    expect(r.allowOrigin).toBe("http://localhost:3001");
  });

  test("multiplexes events from every project the caller is a member of", async () => {
    const text = await collectStream({
      port,
      jwt: s.memberAbJwt,
      waitMs: 600,
      publish: async () => {
        await h.app.broadcaster.publishProjectEvent(s.projectAId, {
          event: "testRun_updated",
          data: { id: "run-a" },
        });
        await h.app.broadcaster.publishProjectEvent(s.projectBId, {
          event: "build_created",
          data: { id: "build-b" },
        });
      },
    });
    expect(text).toContain("event: testRun_updated");
    expect(text).toContain("event: build_created");
  });

  test("does NOT forward events for a project the caller is not a member of", async () => {
    const text = await collectStream({
      port,
      jwt: s.memberAJwt, // member of A only
      waitMs: 600,
      publish: async () => {
        await h.app.broadcaster.publishProjectEvent(s.projectBId, {
          event: "testRun_updated",
          data: { id: "run-b" },
        });
      },
    });
    expect(text).not.toContain("event: testRun_updated");
  });

  test("admin receives events for any project", async () => {
    const text = await collectStream({
      port,
      jwt: s.adminJwt,
      waitMs: 600,
      publish: async () => {
        await h.app.broadcaster.publishProjectEvent(s.projectBId, {
          event: "testRun_updated",
          data: { id: "run-b" },
        });
      },
    });
    expect(text).toContain("event: testRun_updated");
  });

  test("opens cleanly for a caller with no project memberships", async () => {
    const r = await readSseHead(port, "/api/v1/events", {
      authorization: `Bearer ${s.emptyJwt}`,
      accept: "text/event-stream",
    });
    expect(r.code).toBe(200);
  });
});
