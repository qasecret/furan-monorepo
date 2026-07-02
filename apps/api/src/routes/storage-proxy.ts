import {
  and,
  eq,
  inArray,
  or,
  projectMembers,
  screenshots,
  testRuns,
  type DB,
} from "@furan/db";
import { createStorage } from "@furan/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sendError } from "../lib/errors.js";
import { isAtLeastAdmin } from "../lib/roles.js";
import type { AuthedUser } from "../plugins/auth.js";

/**
 * GET /api/v1/storage/:key — project-scoped proxy for storage bytes.
 *
 * Authorization: admins/owners see everything; any other caller may only
 * fetch a key that belongs to a project they're a member of. A key is
 * attributed to a project via the DB rows that reference it —
 * `screenshots.{image,dom,element_map}_key` and `test_runs.{image,diff}_name`
 * (all carry `project_id`). A key the caller can't prove ownership of returns
 * 404 (not 403) so the endpoint never confirms the existence of another
 * tenant's content. (Content-addressed sha256 keys are unguessable, but that
 * was defense-by-obscurity — this closes the actual cross-tenant read.)
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
        return sendError(reply, 404, "not_found");
      }
      const { key } = parsed.data;

      // Project-scope: non-admins may only read keys owned by a project they
      // belong to. 404 (not 403) to avoid confirming existence cross-tenant.
      if (!req.auth || !(await callerCanAccessKey(app.db, req.auth, key))) {
        return sendError(reply, 404, "not_found");
      }

      try {
        const bytes = await storage.get(key);
        if (!bytes || bytes.byteLength === 0) {
          return sendError(reply, 404, "not_found");
        }
        const ct = sniffContentType(bytes);
        reply.header("Content-Type", ct);
        reply.header("Cache-Control", CACHE_HEADER);
        return reply.send(Buffer.from(bytes));
      } catch (err) {
        app.log.error({ err, key }, "storage_proxy_error");
        return sendError(reply, 404, "not_found");
      }
    },
  );
}

/**
 * True if `auth` may read the storage `key`. Admins/owners bypass. Otherwise
 * the key must be referenced by a `screenshots` or `test_runs` row in one of
 * the caller's member projects. Two small indexed lookups; short-circuits on
 * the first hit.
 */
async function callerCanAccessKey(
  db: DB,
  auth: AuthedUser,
  key: string,
): Promise<boolean> {
  if (isAtLeastAdmin(auth.role)) return true;

  const memberRows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, auth.id));
  const projectIds = memberRows.map((r) => r.projectId);
  if (projectIds.length === 0) return false;

  const ss = await db
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(
      and(
        inArray(screenshots.projectId, projectIds),
        or(
          eq(screenshots.imageKey, key),
          eq(screenshots.domKey, key),
          eq(screenshots.elementMapKey, key),
        ),
      ),
    )
    .limit(1);
  if (ss.length > 0) return true;

  const tr = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(
      and(
        inArray(testRuns.projectId, projectIds),
        or(eq(testRuns.imageName, key), eq(testRuns.diffName, key)),
      ),
    )
    .limit(1);
  return tr.length > 0;
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
