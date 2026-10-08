import { humanizeErrorCode, type ApiErrorEnvelope } from "@furan/shared-types";
import type { FastifyReply } from "fastify";

/**
 * Send a REST error using the canonical {@link ApiErrorEnvelope} shape
 * (`{ code, message, statusCode, details? }`). Every route error goes through
 * here so the wire shape is uniform. `message` defaults to a humanized form of
 * `code` when a call site doesn't supply one.
 *
 * Usage: `return sendError(reply, 404, "not_found");`
 *        `return sendError(reply, 400, "invalid_body", undefined, parsed.error.flatten());`
 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message?: string,
  details?: unknown,
): FastifyReply {
  const body: ApiErrorEnvelope = {
    code,
    message: message ?? humanizeErrorCode(code),
    statusCode,
  };
  if (details !== undefined) body.details = details;
  return reply.code(statusCode).send(body);
}

/**
 * Error code for a request that needs a signed-in session but authenticated
 * with an API token (`furan_pat_*`) — token management and admin surfaces
 * (ADR-064 step A). REST sends it as a 403 envelope; tRPC as the FORBIDDEN
 * message.
 */
export const SESSION_REQUIRED = "session_required";

export function sendSessionRequired(reply: FastifyReply): FastifyReply {
  return sendError(
    reply,
    403,
    SESSION_REQUIRED,
    "API tokens can't manage tokens or use admin features; sign in (POST /auth/login) and use the session token",
  );
}
