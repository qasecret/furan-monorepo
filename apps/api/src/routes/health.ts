import { sql } from "@furan/db";
import type { FastifyInstance } from "fastify";

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
  app.get("/livez", async (_req, reply) => {
    return reply.header("cache-control", "no-store").send({ status: "ok" });
  });

  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await withTimeout(app.db.execute(sql`SELECT 1`), PROBE_TIMEOUT_MS);
      checks.postgres = "ok";
    } catch (err) {
      checks.postgres = err instanceof Error ? err.message : "fail";
    }
    // Redis + S3 stubs — wired in P1.D when @furan/queue + @furan/storage land.
    checks.redis = "skipped_until_p1d";
    checks.s3 = "skipped_until_p1d";

    const ok = Object.values(checks).every(
      (v) => v === "ok" || v.startsWith("skipped"),
    );
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
