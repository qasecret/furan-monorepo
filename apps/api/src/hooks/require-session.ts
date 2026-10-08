import type { FastifyReply, FastifyRequest } from "fastify";

import { sendError, sendSessionRequired } from "../lib/errors.js";

/**
 * Rejects API-token (`furan_pat_*`) callers with 403 `session_required`; only
 * a session JWT passes. Used for token management (`/account/tokens`) so a
 * leaked token can't mint a fresh one or revoke others (ADR-064 step A). Run
 * after `app.authenticate`.
 */
export async function requireSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.auth) {
    return sendError(reply, 401, "unauthenticated");
  }
  if (req.auth.via === "pat") {
    return sendSessionRequired(reply);
  }
}
