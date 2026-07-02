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
