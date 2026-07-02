import { projects } from "@furan/db";
import { createRedisConnection } from "@furan/queue";
import { createStorage, type Storage } from "@furan/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const livezResponse = z.object({ status: z.literal("ok") });
export const readyzResponse = z.object({
  checks: z.record(z.string(), z.string()),
});
export const metricsResponse = z
  .string()
  .describe("Prometheus exposition format (text/plain).");

type Redis = ReturnType<typeof createRedisConnection>;

const PROBE_TIMEOUT_MS = 1000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

export async function registerHealthRoutes(
  app: FastifyInstance,
): Promise<void> {
  let redis: Redis | null = null;
  let storage: Storage | null = null;

  const getRedis = (): Redis => {
    if (!redis) redis = createRedisConnection();
    return redis;
  };
  const getStorage = (): Storage => {
    if (!storage) storage = createStorage();
    return storage;
  };

  app.addHook("onClose", async () => {
    if (redis) {
      await redis.quit();
      redis = null;
    }
  });

  app.get("/livez", async (_req, reply) => {
    return reply.header("cache-control", "no-store").send({ status: "ok" });
  });

  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, string> = {};

    try {
      // Read a real, hot table rather than `SELECT 1`. Drizzle emits an
      // explicit column list from the schema, so if the running image expects
      // a column a migration dropped/renamed (the image↔migration drift the
      // deploy runbook warns about), this errors and readiness fails — instead
      // of passing a trivial connectivity check and 500ing on the first real
      // request. LIMIT 1 keeps it O(1).
      await withTimeout(
        app.db.select().from(projects).limit(1),
        PROBE_TIMEOUT_MS,
      );
      checks.postgres = "ok";
    } catch (err) {
      checks.postgres = err instanceof Error ? err.message : "fail";
    }

    try {
      await withTimeout(getRedis().ping(), PROBE_TIMEOUT_MS);
      checks.redis = "ok";
    } catch (err) {
      checks.redis = err instanceof Error ? err.message : "fail";
    }

    try {
      // head() on a sentinel key — returns null when bucket exists but key
      // doesn't; throws when bucket missing. Either way no exception → "ok".
      await withTimeout(
        getStorage().head("__furan_readyz_sentinel__"),
        PROBE_TIMEOUT_MS,
      );
      checks.s3 = "ok";
    } catch (err) {
      checks.s3 = err instanceof Error ? err.message : "fail";
    }

    const ok = Object.values(checks).every((v) => v === "ok");
    return reply
      .code(ok ? 200 : 503)
      .header("cache-control", "no-store")
      .send({ checks });
  });

  app.get("/metrics", async (_req, reply) => {
    const body = await app.telemetry.metrics.metrics();
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(body);
  });
}
