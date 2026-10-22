import { randomBytes } from "node:crypto";

import { getEnv } from "@furan/config";
import { createRedisConnection, type Queue } from "@furan/queue";
import { bootstrapTelemetry } from "@furan/telemetry";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import { envSchema } from "../src/env.js";
import { createApiRuntime } from "../src/runtime.js";

describe("createApiRuntime", () => {
  const telemetry = bootstrapTelemetry({
    service: "api-runtime-test",
    version: "test",
  });
  const open: Array<{ close(): Promise<void> }> = [];
  const prefixes: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((r) => r.close()));
  });

  afterAll(async () => {
    // A queue writes its `meta` key under its prefix when it starts: remove
    // what this file's queues left on the shared test Redis.
    const redis = createRedisConnection();
    try {
      for (const prefix of prefixes) {
        const keys = await redis.keys(`${prefix}:*`);
        if (keys.length > 0) await redis.del(...keys);
      }
    } finally {
      await redis.quit();
    }
    await telemetry.shutdown();
  });

  async function start(): Promise<
    Awaited<ReturnType<typeof createApiRuntime>>
  > {
    const queuePrefix = `furan-scale-test-${randomBytes(4).toString("hex")}`;
    prefixes.push(queuePrefix);
    const runtime = await createApiRuntime({
      env: getEnv(envSchema),
      telemetry,
      queuePrefix,
      rateLimitNamespace: `furan-scale-test-rl-${randomBytes(4).toString("hex")}:`,
    });
    open.push(runtime);
    return runtime;
  }

  test("builds the app, serves /livez and closes idempotently", async () => {
    const runtime = await start();

    const res = await runtime.app.inject({ method: "GET", url: "/livez" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await expect(runtime.close()).resolves.toBeUndefined();
    // A second call is a no-op, not an error from closing twice.
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  test("close releases the diff queue's Redis connection", async () => {
    const runtime = await start();
    // The queue the runtime built is the one the app enqueues on.
    const queue = runtime.app.diffQueue as unknown as Queue;
    const client = await queue.client;
    expect(client.status).toBe("ready");

    await runtime.close();

    // BullMQ leaves a connection it was handed open: the runtime must end it.
    expect(client.status).toBe("end");
  });
});
