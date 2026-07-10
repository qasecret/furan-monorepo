import { afterEach, describe, expect, test } from "vitest";

import { browserEnv, serverApiUrl } from "@/lib/env";

/**
 * serverApiUrl() is the API base URL for SERVER-side callers (Server Actions,
 * the `server-only` apiGet, SSR pages). Unlike NEXT_PUBLIC_API_URL — which Next
 * inlines into both bundles at build time — API_INTERNAL_URL is a plain runtime
 * env var, so one published image can point in-container SSR at http://api:3000
 * while the browser bundle keeps its baked http://localhost:3000.
 */
describe("serverApiUrl", () => {
  const original = process.env.API_INTERNAL_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = original;
  });

  test("prefers API_INTERNAL_URL when set", () => {
    process.env.API_INTERNAL_URL = "http://api:3000";
    expect(serverApiUrl()).toBe("http://api:3000");
  });

  test("falls back to NEXT_PUBLIC_API_URL when API_INTERNAL_URL is unset", () => {
    delete process.env.API_INTERNAL_URL;
    expect(serverApiUrl()).toBe(browserEnv.NEXT_PUBLIC_API_URL);
  });

  test("ignores an empty / whitespace-only API_INTERNAL_URL and falls back", () => {
    process.env.API_INTERNAL_URL = "   ";
    expect(serverApiUrl()).toBe(browserEnv.NEXT_PUBLIC_API_URL);
  });
});
