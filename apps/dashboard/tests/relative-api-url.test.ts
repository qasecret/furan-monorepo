import { describe, expect, test } from "vitest";

import { normalizeApiBase } from "@/lib/env";

/**
 * normalizeApiBase lets the dashboard's API base be either an absolute URL
 * (compose.yml / deploy.sh: http://localhost:3000) or a root-relative path
 * (furan-compose.yml single-origin: /api). A relative base makes every
 * `${base}${path}` fetch same-origin, so one nginx port serves both UI and API.
 */
describe("normalizeApiBase", () => {
  test("accepts an absolute URL unchanged", () => {
    expect(normalizeApiBase("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });

  test("strips a trailing slash from an absolute URL", () => {
    expect(normalizeApiBase("https://api.example.com/")).toBe(
      "https://api.example.com",
    );
  });

  test("accepts a root-relative path (single origin)", () => {
    expect(normalizeApiBase("/api")).toBe("/api");
  });

  test("strips a trailing slash from a relative base", () => {
    expect(normalizeApiBase("/api/")).toBe("/api");
  });

  test("defaults to http://localhost:3000 when empty/undefined", () => {
    expect(normalizeApiBase(undefined)).toBe("http://localhost:3000");
    expect(normalizeApiBase("")).toBe("http://localhost:3000");
  });

  test("rejects a bare host:port with no scheme and no leading slash", () => {
    expect(() => normalizeApiBase("api:3000")).toThrow();
  });
});
