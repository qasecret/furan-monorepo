import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { errorLogLevel } from "../src/lib/error-log-level.js";

import { createTestApp, type TestApp } from "./helpers.js";

describe("global error handler — 5xx body never leaks internals", () => {
  let h: TestApp;
  beforeAll(async () => {
    // skipReady so we can register test-only throw routes before the app
    // finalizes its route tree. Fastify rejects post-ready route adds.
    h = await createTestApp({ skipReady: true });
    h.app.post("/__test/throw-secret", async () => {
      throw new Error(
        "Failed query: insert into users (password) values ('super-secret-pw')",
      );
    });
    h.app.post("/__test/throw-with-status", async () => {
      const err = new Error("not-found-internal-trace") as Error & {
        statusCode: number;
      };
      err.statusCode = 404;
      throw err;
    });
    await h.app.ready();
  });
  afterAll(async () => {
    await h.close();
  });

  test("500-class error returns generic body with no message leak", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/__test/throw-secret",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      code: "internal_error",
      message: "Internal error",
      statusCode: 500,
    });
    const body = res.body;
    expect(body).not.toContain("super-secret-pw");
    expect(body).not.toContain("insert into");
    expect(body).not.toContain("users");
  });

  test("4xx error keeps its message (user-correctable)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/__test/throw-with-status",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { message?: string };
    expect(body.message).toBe("not-found-internal-trace");
  });

  // Regression: tRPC's httpBatchLink encodes the batched procedure list into
  // the URL PATH. Fastify caps a single route param at `maxParamLength`
  // (default 100) and 404s "Route ... not found" past it, so a ~6-procedure
  // batch (101 chars here) failed the whole request and react-query retried it
  // into a loop. We raise maxParamLength so the long path routes to the tRPC
  // handler instead. (The procedures themselves 401 without auth — that's fine;
  // what matters is that it's NOT the Fastify route-not-found rejection.)
  test("long batched tRPC URLs route past Fastify's maxParamLength limit", async () => {
    const path =
      "inbox.count,builds.getById,runs.listCheckpoints,runs.getById,projects.getById,runs.getCheckpointGroup";
    expect(path.length).toBeGreaterThan(100);
    const res = await h.app.inject({
      method: "GET",
      url: `/trpc/${path}?batch=1&input=${encodeURIComponent("{}")}`,
    });
    expect(res.body).not.toMatch(/Route GET:.*not found/i);
  });
});

// T8/T10: a 4xx is the client's (a review refusal, a conflict, a missing row,
// a validation failure): expected traffic, logged at warn so it never pages
// anyone. Only a 5xx is an error.
describe("error log level", () => {
  test.each([400, 401, 403, 404, 409, 412, 429])("%i logs at warn", (s) => {
    expect(errorLogLevel(s)).toBe("warn");
  });
  test.each([500, 502, 503])("%i logs at error", (s) => {
    expect(errorLogLevel(s)).toBe("error");
  });

  test("a tRPC 4xx is logged at warn, not error", async () => {
    const h = await createTestApp();
    try {
      const warn = vi.spyOn(h.app.log, "warn");
      const error = vi.spyOn(h.app.log, "error");
      // No credentials: the procedure answers 401.
      const res = await h.app.inject({
        method: "GET",
        url: `/trpc/inbox.count?input=${encodeURIComponent("{}")}`,
      });
      expect(res.statusCode).toBe(401);
      const trpcLogs = (spy: typeof warn) =>
        spy.mock.calls.filter((c) => c[1] === "trpc_error");
      expect(trpcLogs(warn)).toHaveLength(1);
      expect(trpcLogs(error)).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});
