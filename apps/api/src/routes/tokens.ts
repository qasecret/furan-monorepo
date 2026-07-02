import { and, eq, tokens } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { emitAudit } from "../lib/emit-audit.js";
import { sendError } from "../lib/errors.js";
import { generateRawToken } from "../lib/token.js";

export const createBody = z.object({ label: z.string().min(1).max(80) });

export const paramsId = z.object({ id: z.string().uuid() });

export const tokenSummary = z.object({
  id: z.string().uuid(),
  label: z.string(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
});
export const tokenListResponse = z.array(tokenSummary);
export const tokenCreateResponse = z.object({
  id: z.string().uuid(),
  label: z.string(),
  createdAt: z.date(),
  token: z
    .string()
    .describe("Raw `furan_pat_*` token — shown ONCE, never retrievable again."),
});

export async function registerTokensRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/account/tokens",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      return app.db
        .select({
          id: tokens.id,
          label: tokens.label,
          createdAt: tokens.createdAt,
          lastUsedAt: tokens.lastUsedAt,
        })
        .from(tokens)
        .where(eq(tokens.userId, req.auth.id));
    },
  );

  app.post(
    "/account/tokens",
    {
      preHandler: app.authenticate,
      // PAT minting is rare in normal use; cap the burst so a compromised
      // session can't mass-mint tokens. Opt-in per-route (same pattern as
      // /auth/login) since the rate-limit plugin is registered global:false.
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body");
      }
      const { raw, hash } = generateRawToken();
      const [row] = await app.db
        .insert(tokens)
        .values({ userId: req.auth.id, label: parsed.data.label, hash })
        .returning({
          id: tokens.id,
          label: tokens.label,
          createdAt: tokens.createdAt,
        });
      // PATs are long-lived credentials for CI/SDK — mint/revoke belongs in the
      // audit trail (never the raw token or its hash, only id + label).
      await emitAudit(
        app.db,
        {
          actorId: req.auth.id,
          action: "token.created",
          targetType: "token",
          targetId: row?.id ?? null,
          metadata: { label: parsed.data.label },
        },
        req.log,
      );
      return reply.code(201).send({ ...row, token: raw });
    },
  );

  app.delete(
    "/account/tokens/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      const parsed = paramsId.safeParse(req.params);
      if (!parsed.success) {
        return sendError(reply, 404, "not_found");
      }
      const result = await app.db
        .delete(tokens)
        .where(
          and(eq(tokens.id, parsed.data.id), eq(tokens.userId, req.auth.id)),
        )
        .returning({ id: tokens.id });
      if (result.length === 0) {
        return sendError(reply, 404, "not_found");
      }
      await emitAudit(
        app.db,
        {
          actorId: req.auth.id,
          action: "token.deleted",
          targetType: "token",
          targetId: parsed.data.id,
        },
        req.log,
      );
      return reply.code(204).send();
    },
  );
}
