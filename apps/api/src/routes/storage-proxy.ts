import {
  and,
  eq,
  exists,
  inArray,
  projectMembers,
  screenshots,
  sql,
  testRuns,
  withPrivilegedScope,
  type DB,
  type SQL,
} from "@furan/db";
import { createStorage } from "@furan/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sendError } from "../lib/errors.js";
import type { MemberProjectsCache } from "../lib/member-projects-cache.js";
import { isAtLeastAdmin } from "../lib/roles.js";
import type { AuthedUser } from "../plugins/auth.js";

/**
 * GET /api/v1/storage/:key — project-scoped proxy for storage bytes.
 *
 * Authorization: admins/owners see everything; any other caller may only
 * fetch a key that belongs to a project they're a member of. A key is
 * attributed to a project via the DB rows that reference it —
 * `screenshots.{image,dom,element_map,diff_image}_key` and
 * `test_runs.{image,diff}_name` (all carry `project_id`; see
 * {@link KEY_OWNERSHIP_SOURCES}). A key the caller can't prove ownership of
 * returns 404 (not 403) so the endpoint never confirms the existence of
 * another tenant's content. (Content-addressed sha256 keys are unguessable, but that
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

// `private`: these bytes are authenticated + project-scoped, so only the
// requesting browser may cache them — never a shared cache (corporate proxy,
// CDN) that could re-serve them to another user. Keys are content-addressed,
// so `immutable` is safe and the browser still skips revalidation.
const CACHE_HEADER = "private, max-age=300, immutable";

export async function registerStorageProxyRoute(
  app: FastifyInstance,
): Promise<void> {
  const storage = createStorage(app.telemetry.metrics);

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
      // This IS the authorization boundary, so — like the requireProjectMember
      // gate — it runs PRIVILEGED (RLS bypass): callerCanAccessKey decides
      // access from the caller's membership set + key ownership, and must not be
      // subject to the RLS it enforces (ADR-058). The S3 fetch below stays
      // outside the transaction so a slow object read never holds a DB conn.
      const auth = req.auth;
      const allowed =
        auth != null &&
        (await withPrivilegedScope(app.db, (db) =>
          callerCanAccessKey(db, auth, key, app.memberProjectsCache),
        ));
      if (!allowed) {
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
 * One place a storage key can be attributed to a project: an `EXISTS`
 * subquery that holds iff `key` is referenced, through one key column, by a
 * row of one of `projectIds`. It filters on that single column, so the column's
 * own index answers it.
 */
type KeyOwnershipSource = (
  db: Pick<DB, "select">,
  projectIds: string[],
  key: string,
) => Parameters<typeof exists>[0];

/**
 * Every place a storage key can be attributed to a project. This is the SINGLE
 * source of truth for key→project ownership. The check is fail-closed — a key
 * attributed to no project is denied (404) — so when a new feature adds a
 * key-bearing column or table, it MUST be registered here (and indexed, as
 * migration 0043 does for these), otherwise the proxy will 404 that artifact
 * for legitimate members.
 *
 * {@link keyOwnershipQuery} OR-s one `EXISTS` per source into one statement:
 * - A single `OR` over several key columns can only be answered by a bitmap
 *   scan of all their indexes, which collects every match of a key before it
 *   returns the first one, and a key is shared by every identical screenshot
 *   (the keys are content hashes). One `EXISTS` per column is planned alone and
 *   answered by an index scan that stops at the first match; the `project_id`
 *   list only filters the rows the key matches.
 * - The sparse key columns have indexes that are partial on `IS NOT NULL`,
 *   which `col = key` implies, so those indexes serve their arms.
 * - The arms are evaluated left to right and the evaluation stops at the first
 *   that is true, so the order is the cost: the most-fetched sources come
 *   first, and the one source with no index, the legacy `test_runs.image_name`
 *   (nothing in this repository writes it any more), comes last, so a key that
 *   any other source holds never reaches it. SQL does not promise the order of
 *   an `OR`'s operands; these arms are uncorrelated, so Postgres runs each as
 *   an InitPlan on first use, and the plan test pins that.
 */
const KEY_OWNERSHIP_SOURCES: KeyOwnershipSource[] = [
  // screenshots.image_key: a step's capture.
  (db, projectIds, key) =>
    db
      .select({ one: sql`1` })
      .from(screenshots)
      .where(
        and(
          inArray(screenshots.projectId, projectIds),
          eq(screenshots.imageKey, key),
        ),
      ),
  // screenshots.diff_image_key: a step's own diff image.
  (db, projectIds, key) =>
    db
      .select({ one: sql`1` })
      .from(screenshots)
      .where(
        and(
          inArray(screenshots.projectId, projectIds),
          eq(screenshots.diffImageKey, key),
        ),
      ),
  // screenshots.element_map_key: the element-map sidecar.
  (db, projectIds, key) =>
    db
      .select({ one: sql`1` })
      .from(screenshots)
      .where(
        and(
          inArray(screenshots.projectId, projectIds),
          eq(screenshots.elementMapKey, key),
        ),
      ),
  // screenshots.dom_key: the DOM snapshot.
  (db, projectIds, key) =>
    db
      .select({ one: sql`1` })
      .from(screenshots)
      .where(
        and(
          inArray(screenshots.projectId, projectIds),
          eq(screenshots.domKey, key),
        ),
      ),
  // test_runs.diff_name: a run's worst step's diff image (rows diffed before
  // migration 0041 have no per-step diff key, so it is their only reference).
  (db, projectIds, key) =>
    db
      .select({ one: sql`1` })
      .from(testRuns)
      .where(
        and(
          inArray(testRuns.projectId, projectIds),
          eq(testRuns.diffName, key),
        ),
      ),
  // test_runs.image_name: legacy, no index; last, see above.
  (db, projectIds, key) =>
    db
      .select({ one: sql`1` })
      .from(testRuns)
      .where(
        and(
          inArray(testRuns.projectId, projectIds),
          eq(testRuns.imageName, key),
        ),
      ),
];

/**
 * The ownership check as one statement: `owned` is true iff `key` belongs to a
 * row of one of `projectIds` through any of {@link KEY_OWNERSHIP_SOURCES}.
 * `projectIds` must not be empty.
 */
export function keyOwnershipQuery(
  db: Pick<DB, "select">,
  projectIds: string[],
  key: string,
): SQL {
  const arms = KEY_OWNERSHIP_SOURCES.map((source) =>
    exists(source(db, projectIds, key)),
  );
  return sql`select ${sql.join(arms, sql` or `)} as "owned"`;
}

/**
 * True if `auth` may read the storage `key`. Admins/owners bypass — by role
 * only, so an admin's API token keeps it like the other membership gates
 * (ADR-064 step A). Otherwise the key must be referenced by a row (see
 * {@link KEY_OWNERSHIP_SOURCES}) in one of the caller's member projects. The
 * member-project set is cached per user (short TTL) since the diff viewer
 * fetches many keys per page and the set is stable between membership
 * changes; the ownership check itself is never cached.
 */
async function callerCanAccessKey(
  db: DB,
  auth: AuthedUser,
  key: string,
  cache: MemberProjectsCache | null,
): Promise<boolean> {
  if (isAtLeastAdmin(auth.role)) return true;

  const projectIds = await memberProjectIds(db, auth.id, cache);
  if (projectIds.length === 0) return false;

  const rows = await db.execute<{ owned: boolean }>(
    keyOwnershipQuery(db, projectIds, key),
  );
  return rows[0]?.owned === true;
}

/**
 * The project ids `userId` belongs to, served from cache when present (the
 * storage-proxy hot path). Cache hits skip the `project_members` lookup; a
 * miss reads the DB and populates the cache. Both hits and empty sets are
 * cached so a repeated fetch by a non-member is also cheap.
 */
async function memberProjectIds(
  db: DB,
  userId: string,
  cache: MemberProjectsCache | null,
): Promise<string[]> {
  const cached = cache ? await cache.get(userId) : null;
  if (cached) return cached;

  const memberRows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
  const projectIds = memberRows.map((r) => r.projectId);

  if (cache) await cache.set(userId, projectIds);
  return projectIds;
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
