import { describe, expect, test } from "vitest";

import { envSchema } from "../src/env.js";

describe("envSchema GITHUB_APP_* group refine", () => {
  const base = { DATABASE_URL: "postgresql://x:y@localhost:5432/z" };

  test("accepts all three GitHub App vars omitted", () => {
    const parsed = envSchema.parse({ ...base });
    expect(parsed.GITHUB_APP_ID).toBeUndefined();
    expect(parsed.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(parsed.GITHUB_APP_WEBHOOK_SECRET).toBeUndefined();
  });

  test("accepts all three GitHub App vars set together", () => {
    const parsed = envSchema.parse({
      ...base,
      GITHUB_APP_ID: "1234",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN----- ... -----END-----",
      GITHUB_APP_WEBHOOK_SECRET: "secret",
    });
    expect(parsed.GITHUB_APP_ID).toBe("1234");
  });

  test("rejects partial GitHub App config (only ID set)", () => {
    expect(() => envSchema.parse({ ...base, GITHUB_APP_ID: "1234" })).toThrow(
      /all be set together or all omitted/,
    );
  });

  test("rejects partial GitHub App config (two of three set)", () => {
    expect(() =>
      envSchema.parse({
        ...base,
        GITHUB_APP_ID: "1234",
        GITHUB_APP_PRIVATE_KEY: "key",
      }),
    ).toThrow(/all be set together or all omitted/);
  });
});
