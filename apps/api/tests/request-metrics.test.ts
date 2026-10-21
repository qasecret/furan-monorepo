import { randomBytes, randomUUID } from "node:crypto";

import { projectMembers, projects, users } from "@furan/db";
import { Registry } from "@furan/telemetry";
import { TRPCError } from "@trpc/server";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import {
  classifyStatus,
  procedureOutcome,
  registerRequestMetrics,
  shouldRecordRoute,
} from "../src/lib/request-metrics.js";
import type { Context } from "../src/trpc/context.js";
import { projectsRouter } from "../src/trpc/v1/projects.js";

import { createTestApp, type TestApp } from "./helpers.js";

const HTTP = "furan_http_request_duration_seconds";
const TRPC = "furan_trpc_procedure_duration_seconds";

interface Sample {
  labels: Partial<Record<string, string | number>>;
  count: number;
}

/** prom-client's per-series value; `metricName` marks the `_count` series of a histogram. */
interface SeriesValue {
  value: number;
  labels: Partial<Record<string, string | number>>;
  metricName?: string;
}

/** One entry per label set of histogram `name`, with how many observations it holds. */
async function samples(registry: Registry, name: string): Promise<Sample[]> {
  const metric = registry.getSingleMetric(name);
  if (!metric) return [];
  const { values } = await metric.get();
  return (values as SeriesValue[])
    .filter((v) => v.metricName === `${name}_count`)
    .map((v) => ({ labels: v.labels, count: v.value }));
}

/** Let any hook still pending on the response run before a negative assertion. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("classifyStatus", () => {
  test.each([
    [100, "1xx"],
    [200, "2xx"],
    [204, "2xx"],
    [304, "3xx"],
    [404, "4xx"],
    [429, "4xx"],
    [500, "5xx"],
    [503, "5xx"],
  ] as const)("%i is %s", (code, expected) => {
    expect(classifyStatus(code)).toBe(expected);
  });
});

describe("procedureOutcome", () => {
  test("a successful result is ok", () => {
    expect(procedureOutcome({ ok: true })).toBe("ok");
  });

  test("a failed result whose error is a server error is server_error", () => {
    expect(
      procedureOutcome({
        ok: false,
        error: new TRPCError({ code: "INTERNAL_SERVER_ERROR" }),
      }),
    ).toBe("server_error");
  });

  test("an unexpected throw, wrapped by tRPC, is server_error", () => {
    expect(
      procedureOutcome({
        ok: false,
        error: new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          cause: new Error("boom"),
        }),
      }),
    ).toBe("server_error");
  });

  test.each([
    "FORBIDDEN",
    "UNAUTHORIZED",
    "NOT_FOUND",
    "BAD_REQUEST",
    "CONFLICT",
  ] as const)("a failed result with a %s error is client_error", (code) => {
    expect(
      procedureOutcome({ ok: false, error: new TRPCError({ code }) }),
    ).toBe("client_error");
  });
});

describe("shouldRecordRoute", () => {
  test.each([
    "/metrics",
    "/api/v1/projects/:id/events",
    "/api/v1/runs/:id/events",
    "/events",
  ])("does not record %s", (route) => {
    expect(shouldRecordRoute(route)).toBe(false);
  });

  test.each([
    "/api/v1/storage/:key",
    "/trpc/:path",
    "/livez",
    "unmatched",
    "/events/:id",
    "/api/v1/events-archive",
    "/metrics/:name",
  ])("records %s", (route) => {
    expect(shouldRecordRoute(route)).toBe(true);
  });
});

describe("registerRequestMetrics (bare Fastify)", () => {
  test("observes by route template and skips an /events route", async () => {
    const registry = new Registry();
    const app = Fastify();
    registerRequestMetrics(app, registry);
    app.get("/things/:id", async () => "ok");
    app.get("/things/:id/events", async () => "ok");
    app.get("/metrics", async () => "ok");
    await app.ready();

    await app.inject({ method: "GET", url: "/things/abc" });
    await app.inject({ method: "GET", url: "/things/abc/events" });
    await app.inject({ method: "GET", url: "/metrics" });
    await settle();

    const got = await samples(registry, HTTP);
    expect(got.map((s) => s.labels.route)).toEqual(["/things/:id"]);
    expect(got[0]?.labels).toEqual({
      method: "GET",
      route: "/things/:id",
      status_class: "2xx",
    });
    expect(got[0]?.count).toBe(1);
    await app.close();
  });

  test("two apps on one registry share the one histogram", async () => {
    const registry = new Registry();
    const a = Fastify();
    const b = Fastify();
    registerRequestMetrics(a, registry);
    registerRequestMetrics(b, registry);
    a.get("/x", async () => "ok");
    b.get("/x", async () => "ok");
    await a.inject({ method: "GET", url: "/x" });
    await b.inject({ method: "GET", url: "/x" });
    await settle();

    const got = await samples(registry, HTTP);
    expect(got).toHaveLength(1);
    expect(got[0]?.count).toBe(2);
    await a.close();
    await b.close();
  });
});

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

d("request and procedure latency metrics (full app)", () => {
  let h: TestApp;
  let memberId: string;
  let memberJwt: string;
  let outsiderJwt: string;
  let projectId: string;

  async function seedUser(label: string): Promise<{ id: string }> {
    const [u] = await h.db
      .insert(users)
      .values({
        email: `rm-${label}-${randomUUID()}@t.example`,
        hashedPassword: await hashPassword("pw-not-checked-here"),
        firstName: "RM",
        lastName: label,
        role: "editor",
        isActive: true,
      })
      .returning();
    return { id: u!.id };
  }

  beforeAll(async () => {
    h = await createTestApp();
    const member = await seedUser("member");
    const outsider = await seedUser("outsider");
    const [project] = await h.db
      .insert(projects)
      .values({ name: `rm-${randomUUID()}` })
      .returning();
    projectId = project!.id;
    await h.db
      .insert(projectMembers)
      .values({ userId: member.id, projectId: project!.id });
    memberId = member.id;
    memberJwt = h.app.jwt.sign({ sub: member.id, role: "editor" });
    outsiderJwt = h.app.jwt.sign({ sub: outsider.id, role: "editor" });
  });
  afterAll(async () => {
    await h.close();
  });

  test("labels HTTP by route template", async () => {
    const key = randomBytes(32).toString("hex");
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/storage/${key}`,
      headers: { authorization: `Bearer ${memberJwt}` },
    });
    await settle();

    const got = await samples(h.telemetry.metrics, HTTP);
    const hit = got.find((s) => s.labels.route === "/api/v1/storage/:key");
    expect(hit?.labels).toEqual({
      method: "GET",
      route: "/api/v1/storage/:key",
      status_class: `${Math.floor(res.statusCode / 100)}xx`,
    });
    // The key is a path parameter: it must reach no label, and so no exposition.
    for (const s of got) {
      for (const v of Object.values(s.labels)) {
        expect(String(v)).not.toContain(key);
      }
    }
    expect(await h.telemetry.metrics.metrics()).not.toContain(key);
  });

  test("labels unmatched routes", async () => {
    const path = `/nope-${randomBytes(8).toString("hex")}`;
    const res = await h.app.inject({ method: "GET", url: path });
    await settle();
    expect(res.statusCode).toBe(404);

    const got = await samples(h.telemetry.metrics, HTTP);
    const hit = got.find((s) => s.labels.route === "unmatched");
    expect(hit?.labels).toEqual({
      method: "GET",
      route: "unmatched",
      status_class: "4xx",
    });
    expect(await h.telemetry.metrics.metrics()).not.toContain(path);
  });

  test("skips /metrics", async () => {
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    await settle();
    expect(res.statusCode).toBe(200);

    const got = await samples(h.telemetry.metrics, HTTP);
    expect(got.filter((s) => s.labels.route === "/metrics")).toEqual([]);
    expect(
      got.filter((s) => String(s.labels.route).endsWith("/events")),
    ).toEqual([]);
  });

  test("one sample per procedure in a batch", async () => {
    // A fresh app: its registry holds nothing from the other tests.
    const fresh = await createTestApp();
    try {
      const procedures = [
        "projects.getById",
        "members.list",
        "builds.pendingCount",
      ];
      const input = Object.fromEntries(
        procedures.map((_, i) => [String(i), { projectId }]),
      );
      const res = await fresh.app.inject({
        method: "GET",
        url: `/trpc/${procedures.join(",")}?batch=1&input=${encodeURIComponent(
          JSON.stringify(input),
        )}`,
        headers: { authorization: `Bearer ${memberJwt}` },
      });
      await settle();
      expect(res.statusCode).toBe(200);
      for (const item of res.json() as Array<{ result?: unknown }>) {
        expect(item.result).toBeDefined();
      }

      const got = await samples(fresh.telemetry.metrics, TRPC);
      expect(got).toHaveLength(3);
      expect(got.map((s) => s.labels.procedure).sort()).toEqual(
        [...procedures].sort(),
      );
      for (const s of got) {
        expect(s.labels.type).toBe("query");
        expect(s.labels.outcome).toBe("ok");
        expect(s.count).toBe(1);
      }
    } finally {
      await fresh.close();
    }
  });

  test("classifies a forbidden procedure call as client_error", async () => {
    const fresh = await createTestApp();
    try {
      const query = await fresh.app.inject({
        method: "GET",
        url: `/trpc/projects.getById?input=${encodeURIComponent(
          JSON.stringify({ projectId }),
        )}`,
        headers: { authorization: `Bearer ${outsiderJwt}` },
      });
      const mutation = await fresh.app.inject({
        method: "POST",
        url: "/trpc/projects.update",
        headers: {
          authorization: `Bearer ${outsiderJwt}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ projectId, name: "nope" }),
      });
      await settle();
      expect(query.statusCode).toBe(403);
      expect(mutation.statusCode).toBe(403);

      const got = await samples(fresh.telemetry.metrics, TRPC);
      expect(
        got
          .map((s) => s.labels)
          .sort((a, b) => String(a.type).localeCompare(String(b.type))),
      ).toEqual([
        {
          procedure: "projects.update",
          type: "mutation",
          outcome: "client_error",
        },
        {
          procedure: "projects.getById",
          type: "query",
          outcome: "client_error",
        },
      ]);
    } finally {
      await fresh.close();
    }
  });

  test("a hand-built context with no telemetry gets its result unchanged", async () => {
    const caller = projectsRouter.createCaller({
      user: { id: memberId, role: "editor", via: "jwt" },
      db: h.db,
    } as unknown as Context);

    const project = await caller.getById({ projectId });
    expect(project.id).toBe(projectId);
    await expect(
      caller.getById({ projectId: randomUUID() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
