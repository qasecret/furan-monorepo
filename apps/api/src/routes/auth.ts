import { createHash } from "node:crypto";

import { eq, users } from "@furan/db";
import { userRoleSchema } from "@furan/shared-types";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { recordAuthFailure } from "../lib/auth-metrics.js";
import { sendError } from "../lib/errors.js";
import { verifyPassword } from "../lib/password.js";

export const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const loginResponse = z.object({
  token: z.string().describe("JWT bearer token (signed with HS256)."),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: userRoleSchema,
  }),
});

/**
 * ADR-063 per-account login brake: attempts per account across ALL client
 * IPs, so a distributed guesser (or one hopping proxies) can't exceed 10
 * password tries per 15 min on any one account. Counts every attempt for any
 * email, existing or not, so a 429 says nothing about whether it exists.
 */
export const LOGIN_ACCOUNT_LIMIT = { max: 10, timeWindow: "15 minutes" };

const emailSchema = z.string().email();

/**
 * Per-account bucket id: sha256 of the trimmed, lower-cased email, so the
 * store never holds a raw address and case / whitespace variants share one
 * bucket. null when the body has no plausible email — that request can't
 * reach a password check (the handler 400s), so it isn't counted.
 */
export function loginAccountKey(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { email?: unknown }).email;
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) return null;
  return createHash("sha256").update(email).digest("hex");
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // Built on the plugin's shared store (Redis when wired) via
  // `createRateLimit`, NOT the `app.rateLimit()` preHandler: that handler
  // shares a once-per-request flag with the route's per-IP hook below and so
  // would silently never run on this route.
  const checkAccountLimit = app.createRateLimit({
    ...LOGIN_ACCOUNT_LIMIT,
    keyGenerator: (req) => `login-account:${loginAccountKey(req.body) ?? ""}`,
  });

  app.post(
    "/auth/login",
    {
      // Brute-force / credential-stuffing brake on the one unauthenticated
      // credential endpoint. Opt-in per-route (the plugin is registered with
      // `global: false`), keyed by client IP (req.ip — see TRUST_PROXY).
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      // Per-account limit runs after body parsing (it needs the email). A
      // store error is skipped (fail open), like the per-IP limit.
      preHandler: async (req, reply) => {
        const accountKey = loginAccountKey(req.body);
        if (accountKey === null) return;
        const limit = await checkAccountLimit(req);
        if (limit.isAllowed || !limit.isExceeded) return;
        req.log.warn({ accountKey }, "login_account_rate_limited");
        void reply
          .header("x-ratelimit-limit", limit.max)
          .header("x-ratelimit-remaining", 0)
          .header("x-ratelimit-reset", limit.ttlInSeconds)
          .header("retry-after", limit.ttlInSeconds);
        return sendError(
          reply,
          429,
          "rate_limited",
          `Rate limit exceeded, retry after ${limit.ttlInSeconds}s`,
        );
      },
    },
    async (req, reply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) {
        // Don't echo the Zod field/constraint map back on the unauthenticated
        // login endpoint — it needlessly reveals the expected schema shape.
        return sendError(reply, 400, "invalid_body");
      }
      const { email, password } = parsed.data;

      const rows = await app.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const user = rows[0];
      if (!user || !user.isActive) {
        recordAuthFailure(app.telemetry.metrics, "invalid_credentials");
        return sendError(reply, 401, "invalid_credentials");
      }
      const ok = await verifyPassword(password, user.hashedPassword);
      if (!ok) {
        recordAuthFailure(app.telemetry.metrics, "invalid_credentials");
        return sendError(reply, 401, "invalid_credentials");
      }

      const token = await reply.jwtSign({ sub: user.id, role: user.role });
      return reply.code(200).send({
        token,
        user: { id: user.id, email: user.email, role: user.role },
      });
    },
  );
}
