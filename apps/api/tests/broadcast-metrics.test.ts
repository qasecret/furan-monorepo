import { Registry } from "@furan/telemetry";
import { describe, expect, test } from "vitest";

import {
  releaseConnection,
  tryAcquireConnection,
} from "../src/lib/broadcast-metrics.js";

/**
 * Pure unit coverage for the SSE concurrent-connection cap backing the DoS
 * backstop. Each test uses its own Registry so the per-registry WeakMap state
 * (live count + counters) is isolated.
 */
describe("SSE connection cap (broadcast-metrics)", () => {
  test("acquires up to the cap, then rejects", () => {
    const reg = new Registry();
    expect(tryAcquireConnection(reg, 2)).toBe(true);
    expect(tryAcquireConnection(reg, 2)).toBe(true);
    // Third request is over the cap → rejected.
    expect(tryAcquireConnection(reg, 2)).toBe(false);
  });

  test("releasing a slot lets a new connection in", () => {
    const reg = new Registry();
    expect(tryAcquireConnection(reg, 1)).toBe(true);
    expect(tryAcquireConnection(reg, 1)).toBe(false);
    releaseConnection(reg);
    expect(tryAcquireConnection(reg, 1)).toBe(true);
  });

  test("double-release cannot drive the count negative (over-admits nothing)", () => {
    const reg = new Registry();
    expect(tryAcquireConnection(reg, 1)).toBe(true);
    releaseConnection(reg);
    releaseConnection(reg); // spurious second release (close + aborted)
    // Only one slot should be free — not two.
    expect(tryAcquireConnection(reg, 1)).toBe(true);
    expect(tryAcquireConnection(reg, 1)).toBe(false);
  });

  test("increments the rejected counter on rejection", async () => {
    const reg = new Registry();
    tryAcquireConnection(reg, 1);
    tryAcquireConnection(reg, 1); // rejected
    tryAcquireConnection(reg, 1); // rejected
    const metric = await reg.getSingleMetricAsString(
      "furan_sse_connections_rejected_total",
    );
    // prom-client renders the scalar sample as `<name> <value>`.
    expect(metric).toMatch(/furan_sse_connections_rejected_total 2/);
  });

  test("reflects live count in the active-connections gauge", async () => {
    const reg = new Registry();
    tryAcquireConnection(reg, 5);
    tryAcquireConnection(reg, 5);
    const gauge = await reg.getSingleMetricAsString(
      "furan_project_sse_connections_active",
    );
    expect(gauge).toMatch(/furan_project_sse_connections_active 2/);
  });
});
