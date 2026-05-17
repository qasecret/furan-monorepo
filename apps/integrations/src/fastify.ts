import type { Telemetry } from "@furan/telemetry";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { Env } from "./env.js";

export interface BuildFastifyDeps {
  env: Env;
  telemetry: Telemetry;
}

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    telemetry: Telemetry;
  }
}

/**
 * Build the Fastify instance for the integrations service.
 *
 * T7 mounts placeholder routes only — `POST /webhooks/github` (filled in
 * by T8) and `POST /webhooks/slack` (filled in by T9, if/when inbound
 * Slack interactions are added). Both return 501 so misconfigured callers
 * fail loudly during the v1.0 install/dogfood window.
 *
 * Pino + OTel + prom-client wiring comes through `@furan/telemetry`,
 * matching apps/api/src/app.ts so log shape is identical across services.
 */
export async function buildFastify(
  deps: BuildFastifyDeps,
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.telemetry.logger as unknown as FastifyBaseLogger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
  });

  app.decorate("env", deps.env);
  app.decorate("telemetry", deps.telemetry);

  // Placeholder: filled in by Phase 4 Task 8 (GitHub App webhook receiver).
  app.post("/webhooks/github", async (_req, reply) => {
    return reply.code(501).send({ error: "not_implemented", task: "T8" });
  });

  // Placeholder: filled in by Phase 4 Task 9 if/when inbound Slack
  // interactions (slash commands, button payloads) are added. Outbound
  // Slack notifications go through SLACK_WEBHOOK_URL and don't touch
  // Fastify at all.
  app.post("/webhooks/slack", async (_req, reply) => {
    return reply.code(501).send({ error: "not_implemented", task: "T9" });
  });

  // /livez is mirrored on Fastify (handy for in-cluster sidecars) — the
  // canonical liveness/readiness/metrics endpoints live on the separate
  // node:http health server (see src/health.ts).
  app.get("/livez", async (_req, reply) => {
    return reply.header("cache-control", "no-store").send({ status: "ok" });
  });

  return app;
}
