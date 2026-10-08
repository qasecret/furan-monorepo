import { afterEach, describe, expect, test, vi } from "vitest";

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

/**
 * When the browser base is baked RELATIVE (/api, single-origin furan-compose),
 * server-side code cannot fetch it — a relative URL has no host from inside the
 * container. It must use the runtime API_INTERNAL_URL, and fail loudly if that
 * is missing. The baked value is import-time frozen, so these reload the module
 * with a relative NEXT_PUBLIC_API_URL set.
 */
describe("serverApiUrl with a relative baked base", () => {
  const prevPub = process.env.NEXT_PUBLIC_API_URL;
  const prevInt = process.env.API_INTERNAL_URL;
  afterEach(() => {
    if (prevPub === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = prevPub;
    if (prevInt === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = prevInt;
    vi.resetModules();
  });

  test("uses API_INTERNAL_URL for SSR", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_API_URL = "/api";
    process.env.API_INTERNAL_URL = "http://api:3000";
    const mod = await import("@/lib/env");
    expect(mod.serverApiUrl()).toBe("http://api:3000");
  });

  test("throws when API_INTERNAL_URL is unset (relative base is unfetchable server-side)", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_API_URL = "/api";
    delete process.env.API_INTERNAL_URL;
    const mod = await import("@/lib/env");
    expect(() => mod.serverApiUrl()).toThrow(/API_INTERNAL_URL/);
  });
});
