import type { Telemetry } from "@furan/telemetry";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { App } from "octokit";

import type { Env } from "./env.js";

export interface BuildFastifyDeps {
  env: Env;
  telemetry: Telemetry;
  githubApp?: App;
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
 * T8: `POST /webhooks/github` delegates to `app.webhooks.verifyAndReceive`
 * which does HMAC-SHA256 signature verification + dispatches to the
 * handlers registered in `src/github/webhook-handlers.ts`. If the GitHub
 * App isn't configured (no env secrets), the route returns 503 so a
 * misconfigured webhook subscription fails loudly.
 *
 * `POST /webhooks/slack` is still a placeholder for T9 (inbound Slack
 * interactions — outbound notifications go through SLACK_WEBHOOK_URL and
 * don't touch Fastify at all).
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
    // Bound request receipt (slow-loris protection). No SSE here, but keep
    // the ceiling consistent with the api service.
    requestTimeout: 120_000,
  });

  app.decorate("env", deps.env);
  app.decorate("telemetry", deps.telemetry);

  // Mirror the api's generic-5xx error handler so an unhandled throw in a
  // webhook handler doesn't leak stack frames / internal detail to the caller,
  // and every error lands in the structured log with its reqId. 4xx pass
  // through so validation messages still reach the client.
  app.setErrorHandler(
    (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      const status =
        err.statusCode && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;
      req.log.error({ err, reqId: req.id, url: req.url }, "request_error");
      if (status >= 500) {
        return reply.code(status).send({ error: "internal_error" });
      }
      return reply.code(status).send({
        statusCode: status,
        error: err.name || "Error",
        message: err.message,
      });
    },
  );

  const githubApp = deps.githubApp;

  app.post("/webhooks/github", async (request, reply) => {
    if (!githubApp) {
      return reply.code(503).send({ error: "github_app_not_configured" });
    }
    const id = request.headers["x-github-delivery"];
    const name = request.headers["x-github-event"];
    const signature = request.headers["x-hub-signature-256"];
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof signature !== "string"
    ) {
      return reply.code(400).send({ error: "missing_github_headers" });
    }
    try {
      await githubApp.webhooks.verifyAndReceive({
        id,
        // octokit's webhook event-name union is wide; the runtime check
        // is the HMAC verify call below, so the cast is safe.
        name: name as Parameters<
          typeof githubApp.webhooks.verifyAndReceive
        >[0]["name"],
        signature,
        payload: JSON.stringify(request.body),
      });
      return reply.code(204).send();
    } catch (err) {
      request.log.error({ err }, "github_webhook_verify_failed");
      return reply.code(400).send({ error: "invalid_signature" });
    }
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
