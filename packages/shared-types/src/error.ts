import { z } from "zod";

/**
 * Canonical API error envelope. Every REST error response uses this shape so
 * clients have one thing to parse. `code` is the stable, machine-readable key
 * clients branch on (e.g. `"invalid_body"`, `"not_found"`); `message` is a
 * human-readable string (always present); `statusCode` mirrors the HTTP status
 * for callers that only have the body; `details` carries optional structured
 * context (e.g. a Zod flatten() for validation failures).
 *
 * tRPC keeps its own (already-standardized) error envelope — this is for the
 * REST surface, which previously returned ad-hoc `{ error: "..." }` bodies.
 */
export const apiErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
  details: z.unknown().optional(),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

/** Humanize a snake_case error code into a default message, e.g.
 *  `"invalid_body"` -> `"Invalid body"`. Used when a call site doesn't supply
 *  an explicit message. */
export function humanizeErrorCode(code: string): string {
  const spaced = code.replace(/_/g, " ").trim();
  if (!spaced) return code;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
