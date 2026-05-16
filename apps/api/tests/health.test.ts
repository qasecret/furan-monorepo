import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "./helpers.js";

describe("health endpoints", () => {
  let h: TestApp;
  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  test("GET /livez returns 200 ok", async () => {
    const res = await h.app.inject({ method: "GET", url: "/livez" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  test("GET /readyz returns 200 when Postgres reachable", async () => {
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { checks: { postgres: string } };
    expect(body.checks.postgres).toBe("ok");
  });

  test("GET /metrics returns prometheus text", async () => {
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toMatch(/process_cpu_seconds_total/);
  });
});
