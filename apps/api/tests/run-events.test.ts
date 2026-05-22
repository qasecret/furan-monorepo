import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  builds,
  projectMembers,
  projects,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import { createRedisConnection } from "@furan/queue";
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

const skip = !process.env.DATABASE_URL || !process.env.REDIS_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  memberId: string;
  memberJwt: string;
  nonMemberId: string;
  nonMemberJwt: string;
  runId: string;
  projectId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents.
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [member] = await h.db
    .insert(users)
    .values({
      email: "member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Mem",
      lastName: "Ber",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [nonMember] = await h.db
    .insert(users)
    .values({
      email: "nonmember@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Non",
      lastName: "Mem",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "alpha" })
    .returning();

  await h.db
    .insert(projectMembers)
    .values({ userId: member.id, projectId: project.id });

  const [build] = await h.db
    .insert(builds)
    .values({
      projectId: project.id,
      userId: member.id,
      isRunning: true,
    })
    .returning();

  const [variation] = await h.db
    .insert(testVariations)
    .values({ name: "home", projectId: project.id })
    .returning();

  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: build.id,
      projectId: project.id,
      testVariationId: variation.id,
      status: "new",
    })
    .returning();

  return {
    memberId: member.id,
    memberJwt: h.app.jwt.sign({ sub: member.id, role: "editor" }),
    nonMemberId: nonMember.id,
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember.id, role: "editor" }),
    runId: run.id,
    projectId: project.id,
  };
}

d("GET /api/v1/runs/:id/events", () => {
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
    // SSE never naturally closes, so app.inject() would block. Hit the real
    // listening socket, read response headers, then disconnect.
    const status = await new Promise<{ code: number; ctype: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `/api/v1/runs/${s.runId}/events`,
            headers: {
              authorization: `Bearer ${s.memberJwt}`,
              accept: "text/event-stream",
            },
          },
          (response) => {
            resolve({
              code: response.statusCode ?? 0,
              ctype: String(response.headers["content-type"] ?? ""),
            });
            response.destroy();
            req.destroy();
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(status.code).toBe(200);
    expect(status.ctype).toMatch(/text\/event-stream/);
  });

  test("includes CORS Allow-Origin when request comes from allowed origin", async () => {
    // reply.hijack() in the SSE handler bypasses Fastify's onSend pipeline,
    // so @fastify/cors never adds Allow-Origin to the stream. Without an
    // explicit mirror, the dashboard's EventSource fails cross-origin with
    // "blocked by CORS policy". This test pins the mirror behavior.
    const headers = await new Promise<Record<string, string | undefined>>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `/api/v1/runs/${s.runId}/events`,
            headers: {
              authorization: `Bearer ${s.memberJwt}`,
              accept: "text/event-stream",
              origin: "http://localhost:3001",
            },
          },
          (response) => {
            resolve({
              "access-control-allow-origin": response.headers[
                "access-control-allow-origin"
              ] as string | undefined,
              "access-control-allow-credentials": response.headers[
                "access-control-allow-credentials"
              ] as string | undefined,
              vary: response.headers["vary"] as string | undefined,
            });
            response.destroy();
            req.destroy();
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(headers["access-control-allow-origin"]).toBe(
      "http://localhost:3001",
    );
    expect(headers["access-control-allow-credentials"]).toBe("true");
    expect(headers["vary"]).toContain("Origin");
  });

  test("does NOT include CORS Allow-Origin when origin is not allowlisted", async () => {
    const headers = await new Promise<{ allowOrigin: string | undefined }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `/api/v1/runs/${s.runId}/events`,
            headers: {
              authorization: `Bearer ${s.memberJwt}`,
              accept: "text/event-stream",
              origin: "https://evil.example.com",
            },
          },
          (response) => {
            resolve({
              allowOrigin: response.headers["access-control-allow-origin"] as
                | string
                | undefined,
            });
            response.destroy();
            req.destroy();
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    // Either undefined or empty — never an echo of the disallowed origin.
    expect(headers.allowOrigin).toBeUndefined();
  });

  test("returns 403 for non-member", async () => {
    // The 403 short-circuits in the preHandler before reply.hijack() runs, so
    // app.inject() handles it fine — but for consistency we use the real socket.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/api/v1/runs/${s.runId}/events`,
          headers: {
            authorization: `Bearer ${s.nonMemberJwt}`,
            accept: "text/event-stream",
          },
        },
        (response) => {
          resolve(response.statusCode ?? 0);
          response.resume();
          response.on("end", () => req.destroy());
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  test("streams events published to run:{id}:events", async () => {
    const pub = createRedisConnection();
    const chunks: string[] = [];
    let gotHeaders = false;

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/v1/runs/${s.runId}/events`,
        headers: {
          authorization: `Bearer ${s.memberJwt}`,
          accept: "text/event-stream",
        },
      },
      (response) => {
        gotHeaders = true;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => chunks.push(chunk));
      },
    );
    req.end();

    // Wait until response headers arrive (Redis subscribe runs *after* writeHead).
    const start = Date.now();
    while (!gotHeaders && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // Tiny extra slack for the subscribe() promise to resolve.
    await new Promise((r) => setTimeout(r, 250));

    await pub.publish(
      `run:${s.runId}:events`,
      JSON.stringify({ type: "diff.completed", runId: s.runId }),
    );

    // Wait for SSE frame to land.
    const t0 = Date.now();
    while (
      chunks.join("").indexOf("diff.completed") < 0 &&
      Date.now() - t0 < 5000
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    req.destroy();
    pub.disconnect();

    const text = chunks.join("");
    expect(text).toContain("event: progress");
    expect(text).toContain("diff.completed");
  });
});
