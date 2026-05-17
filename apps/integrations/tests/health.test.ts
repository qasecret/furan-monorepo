import type { AddressInfo } from "node:net";

import { bootstrapTelemetry, type Telemetry } from "@furan/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { startHealthServer } from "../src/health.js";

describe("integrations health server", () => {
  let telemetry: Telemetry;
  let server: ReturnType<typeof startHealthServer>;
  let baseUrl: string;

  beforeAll(async () => {
    telemetry = bootstrapTelemetry({
      service: "integrations-test",
      version: "test",
    });
    // Pass port 0 so the OS picks an ephemeral port — avoids 3300 collisions.
    server = startHealthServer({ port: 0, telemetry });
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await telemetry.shutdown();
  });

  test("GET /healthz returns 200 ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("GET /livez returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /readyz returns 200 when ready callback omitted", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /metrics returns prometheus text", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toMatch(/process_cpu_seconds_total/);
  });

  test("GET /unknown returns 404", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});
