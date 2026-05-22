import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "./helpers.js";

describe("CORS preflight + actual cross-origin requests", () => {
  let h: TestApp;
  beforeAll(async () => {
    h = await createTestApp({
      envOverrides: {
        FURAN_DASHBOARD_ORIGIN:
          "http://localhost:3001,https://furan.example.com",
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  test("OPTIONS /projects from allowed origin → 204 with CORS headers", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: {
        origin: "http://localhost:3001",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3001",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    const allowMethods = String(res.headers["access-control-allow-methods"]);
    expect(allowMethods).toContain("POST");
  });

  test("OPTIONS /projects from second allowlisted origin → 204", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: {
        origin: "https://furan.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://furan.example.com",
    );
  });

  test("POST /projects from allowed origin without creds → 401 still has CORS header", async () => {
    // Even when auth fails, the Allow-Origin header must be present so the
    // browser exposes the 401 body to the dashboard for error messaging.
    const res = await h.app.inject({
      method: "POST",
      url: "/projects",
      headers: {
        origin: "http://localhost:3001",
        "content-type": "application/json",
      },
      payload: { name: "demo" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3001",
    );
  });

  test("OPTIONS /projects from non-allowlisted origin → no CORS allow header", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/projects",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    // @fastify/cors replies without an Allow-Origin header for disallowed
    // origins; the browser then blocks the actual request.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
