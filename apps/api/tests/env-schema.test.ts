import { describe, expect, it } from "vitest";

import { envSchema } from "../src/env.js";

const VALID_BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://furan:devpw@localhost:5433/furan_dev",
  JWT_SECRET: "x".repeat(32),
};

describe("envSchema bootstrap fields", () => {
  it("accepts both bootstrap fields unset", () => {
    const result = envSchema.safeParse({ ...VALID_BASE });
    expect(result.success).toBe(true);
  });

  it("accepts a valid email + ≥8-char password", () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      FURAN_BOOTSTRAP_ADMIN_EMAIL: "you@example.test",
      FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
    });
    expect(result.success).toBe(true);
  });

  it("refuses the `change-me` placeholder for email", () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      FURAN_BOOTSTRAP_ADMIN_EMAIL: "change-me",
      FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(
        /must be replaced from \.env\.example placeholder|Invalid email/,
      );
    }
  });

  it("refuses a malformed email", () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      FURAN_BOOTSTRAP_ADMIN_EMAIL: "not-an-email",
      FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
    });
    expect(result.success).toBe(false);
  });

  it("refuses the `change-me-run:` placeholder prefix for password", () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      FURAN_BOOTSTRAP_ADMIN_EMAIL: "you@example.test",
      FURAN_BOOTSTRAP_ADMIN_PASSWORD: "change-me-run: openssl rand -hex 24",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/must be replaced from \.env\.example placeholder/);
    }
  });

  it("refuses a password shorter than 8 chars", () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      FURAN_BOOTSTRAP_ADMIN_EMAIL: "you@example.test",
      FURAN_BOOTSTRAP_ADMIN_PASSWORD: "short77",
    });
    expect(result.success).toBe(false);
  });
});
