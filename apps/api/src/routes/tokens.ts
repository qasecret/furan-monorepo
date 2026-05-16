import { and, eq, tokens } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { generateRawToken } from "../lib/token.js";

const createBody = z.object({ label: z.string().min(1).max(80) });

const paramsId = z.object({ id: z.string().uuid() });

export async function registerTokensRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/account/tokens",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "unauthenticated" });
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
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
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
      return reply.code(201).send({ ...row, token: raw });
    },
  );

  app.delete(
    "/account/tokens/:id",
    { preHandler: app.authenticate },
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const parsed = paramsId.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const result = await app.db
        .delete(tokens)
        .where(
          and(eq(tokens.id, parsed.data.id), eq(tokens.userId, req.auth.id)),
        )
        .returning({ id: tokens.id });
      if (result.length === 0) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(204).send();
    },
  );
}
