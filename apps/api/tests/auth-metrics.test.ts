import { Registry } from "@furan/telemetry";
import { describe, expect, test } from "vitest";

import { recordAuthFailure } from "../src/lib/auth-metrics.js";

/**
 * Pure coverage for the auth-failure security counter. A fresh Registry per
 * test isolates the per-registry WeakMap state.
 */
describe("recordAuthFailure", () => {
  test("counts failures per reason label", async () => {
    const reg = new Registry();
    recordAuthFailure(reg, "invalid_jwt");
    recordAuthFailure(reg, "invalid_jwt");
    recordAuthFailure(reg, "account_inactive");
    const out = await reg.getSingleMetricAsString("furan_auth_failures_total");
    expect(out).toMatch(/furan_auth_failures_total\{reason="invalid_jwt"\} 2/);
    expect(out).toMatch(
      /furan_auth_failures_total\{reason="account_inactive"\} 1/,
    );
  });

  test("registers a single series across repeated calls on one registry", async () => {
    const reg = new Registry();
    recordAuthFailure(reg, "missing_credentials");
    recordAuthFailure(reg, "invalid_credentials");
    // Registering twice for the same registry must not throw or duplicate.
    recordAuthFailure(reg, "invalid_pat");
    const metrics = await reg.getMetricsAsJSON();
    const series = metrics.filter((m) => m.name === "furan_auth_failures_total");
    expect(series).toHaveLength(1);
  });
});
