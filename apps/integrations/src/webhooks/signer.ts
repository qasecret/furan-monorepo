import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256 hex digest of `body` keyed by `secret`. The wire format the
 * delivery worker sends is `X-Furan-Signature: sha256=<hex>` so subscribers
 * can verify with a constant-time compare against the same primitive.
 *
 * Kept as a pure, dep-free function so the spec tests can pin it to a
 * single canonical value without standing up the full delivery pipeline.
 */
export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
