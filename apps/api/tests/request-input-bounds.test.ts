import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "./helpers.js";

/**
 * CVE-2023-54404: zod 3 parses every element of an oversized array before
 * rejecting it, and tRPC parses input before `authed` runs. These requests are
 * all anonymous: an oversized input must fail on its size alone (one issue, a
 * small response), and no JSON body past 1 MB may reach a parser at all.
 */
describe("request input bounds", () => {
  let h: TestApp;
  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  function approve(checkpointIds: string[]) {
    return h.app.inject({
      method: "POST",
      url: "/trpc/review.approve",
      headers: { "content-type": "application/json" },
      payload: { runId: randomUUID(), actionId: randomUUID(), checkpointIds },
    });
  }

  test("an oversized tRPC array fails on its size, before any element is parsed", async () => {
    // ~400 KB: under the body limit, and 30,000 bad elements that zod 3 would
    // otherwise turn into 30,000 issues (a multi-MB error response).
    const res = await approve(Array(30_000).fill("not-a-uuid"));

    expect(res.statusCode).toBe(400);
    expect(res.body.length).toBeLessThan(5_000);
    expect(res.body).toContain("Array must contain at most 500 element(s)");
    expect(res.body).not.toContain("Invalid uuid");
  });

  test("an input at the cap passes validation and is refused by auth", async () => {
    const res = await approve(Array.from({ length: 500 }, () => randomUUID()));

    expect(res.statusCode).toBe(401);
  });

  test("a tRPC body over 1 MB is refused before parsing", async () => {
    const res = await approve(Array(100_000).fill("not-a-uuid"));

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: "FST_ERR_CTP_BODY_TOO_LARGE" });
  });

  test("a REST JSON body over 1 MB is refused before parsing", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/projects",
      headers: { "content-type": "application/json" },
      payload: { name: "x".repeat(1024 * 1024) },
    });

    expect(res.statusCode).toBe(413);
  });
});
