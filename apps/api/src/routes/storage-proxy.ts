import { createStorage } from "@furan/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * GET /api/v1/storage/:key — authenticated proxy for storage bytes.
 *
 * v1.0 simplification (`non_authoritative_v1_simplification`): the route
 * checks `app.authenticate` (any user) rather than `requireProjectMember`.
 * Full project-scoped enforcement would require a reverse index
 * (key → run → project) we do not maintain. Defense-in-depth: storage
 * keys are sha256 hex of content — unguessable. Acceptable for small-team
 * v1.0; upgrade in Phase 3 if cross-project leakage becomes a concern.
 */
export const paramsSchema = z.object({
  key: z
    .string()
    .regex(
      /^[0-9a-f]{64}(\.elements\.json)?$/,
      "must be a sha256 hex (with optional .elements.json suffix)",
    ),
});

const CACHE_HEADER = "public, max-age=300, immutable";

export async function registerStorageProxyRoute(
  app: FastifyInstance,
): Promise<void> {
  const storage = createStorage();

  app.get(
    "/api/v1/storage/:key",
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const { key } = parsed.data;

      try {
        const bytes = await storage.get(key);
        if (!bytes || bytes.byteLength === 0) {
          return reply.code(404).send({ error: "not_found" });
        }
        const ct = sniffContentType(bytes);
        reply.header("Content-Type", ct);
        reply.header("Cache-Control", CACHE_HEADER);
        return reply.send(Buffer.from(bytes));
      } catch (err) {
        app.log.error({ err, key }, "storage_proxy_error");
        return reply.code(404).send({ error: "not_found" });
      }
    },
  );
}

/**
 * Magic-byte sniff. v1.0 expects WebP screenshots + PNG diff overlays.
 * sha256 keys carry no type metadata so we sniff the body itself.
 */
function sniffContentType(bytes: Uint8Array): string {
  // JSON: '{' as first byte. The element-map sidecar is always an object.
  // Goes before binary checks so a JSON body that happens to share an
  // early byte with a binary magic doesn't get misdetected. (The PNG /
  // WebP / JPEG magic-byte checks below are not ambiguous with 0x7b.)
  if (bytes.length >= 1 && bytes[0] === 0x7b) {
    return "application/json";
  }
  // PNG: 89 50 4E 47
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // JPEG: FF D8 FF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}
