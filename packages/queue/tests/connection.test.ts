import { createServer } from "node:net";

import { describe, expect, test } from "vitest";

import { createFailFastRedisConnection } from "../src/index.js";

// A port nothing listens on: bind an ephemeral port, then release it.
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("createFailFastRedisConnection", () => {
  test("uses bounded, non-queuing options (unlike the BullMQ connection)", () => {
    const redis = createFailFastRedisConnection("redis://127.0.0.1:1");
    redis.on("error", () => undefined);
    try {
      expect(redis.options).toMatchObject({
        connectTimeout: 500,
        commandTimeout: 500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
    } finally {
      redis.disconnect();
    }
  });

  test("a command against an unreachable Redis rejects promptly instead of hanging", async () => {
    const redis = createFailFastRedisConnection(
      `redis://127.0.0.1:${await closedPort()}`,
    );
    redis.on("error", () => undefined);
    try {
      const started = Date.now();
      await expect(redis.incr("furan:test:failfast")).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      redis.disconnect();
    }
  });
});
