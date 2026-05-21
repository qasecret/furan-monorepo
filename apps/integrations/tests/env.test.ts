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

describe("envSchema optional URL fields tolerate empty string", () => {
  const base = { DATABASE_URL: "postgresql://x:y@localhost:5432/z" };

  test("empty SLACK_WEBHOOK_URL parses to undefined", () => {
    const parsed = envSchema.parse({ ...base, SLACK_WEBHOOK_URL: "" });
    expect(parsed.SLACK_WEBHOOK_URL).toBeUndefined();
  });

  test("set SLACK_WEBHOOK_URL is preserved", () => {
    const parsed = envSchema.parse({
      ...base,
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
    });
    expect(parsed.SLACK_WEBHOOK_URL).toBe(
      "https://hooks.slack.com/services/T/B/X",
    );
  });

  test("non-URL SLACK_WEBHOOK_URL still rejected", () => {
    expect(() =>
      envSchema.parse({ ...base, SLACK_WEBHOOK_URL: "not-a-url" }),
    ).toThrow();
  });

  test("empty OTLP_ENDPOINT parses to undefined", () => {
    const parsed = envSchema.parse({ ...base, OTLP_ENDPOINT: "" });
    expect(parsed.OTLP_ENDPOINT).toBeUndefined();
  });
});
