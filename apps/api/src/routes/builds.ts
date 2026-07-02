import { and, builds, desc, eq, projects, sql } from "@furan/db";
import { buildPropertiesSchema } from "@furan/shared-types";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { recordBuildCreate } from "../lib/builds-metrics.js";
import { sendError } from "../lib/errors.js";
import { withRequestScope } from "../lib/with-request-scope.js";

export const createBody = z.object({
  ciBuildId: z.string().min(1).max(200).optional(),
  number: z.number().int().optional(),
  branchName: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  properties: buildPropertiesSchema.optional(),
});

export const paramsId = z.object({ id: z.string().uuid() });

export const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  branch: z.string().min(1).max(200).optional(),
  /**
   * Repeatable `property=key=value` query param, e.g.
   * `?property=region=us-east-1&property=shard=2`. Each entry AND-joined into
   * a single `properties @> '{...}'` predicate that the GIN index serves.
   */
  property: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
});

export const buildResponse = z.object({
  id: z.string().uuid(),
  ciBuildId: z.string().nullable(),
  number: z.number().int().nullable(),
  branchName: z.string().nullable(),
  status: z.string().nullable(),
  name: z.string().nullable(),
  properties: z.record(z.string(), z.string()),
  projectId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  isRunning: z.boolean(),
  environment: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const buildListResponse = z.object({
  items: z.array(buildResponse),
  nextCursor: z.string().nullable(),
});

function parsePropertyFilter(raw: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx <= 0) return null;
    const k = entry.slice(0, eqIdx);
    const v = entry.slice(eqIdx + 1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(k) || k.length > 64 || v.length > 256) {
      return null;
    }
    out[k] = v;
  }
  return out;
}

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { createdAt: string; id: string };
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

export async function registerBuildsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/projects/:id/builds",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("read", { from: { params: "id" } }),
      ],
    },
    async (req, reply) => {
      const paramsParsed = paramsId.safeParse(req.params);
      if (!paramsParsed.success) {
        return sendError(reply, 404, "not_found");
      }
      const queryParsed = querySchema.safeParse(req.query);
      if (!queryParsed.success) {
        return sendError(reply, 400, "invalid_query");
      }
      const propertyMap = parsePropertyFilter(queryParsed.data.property);
      if (propertyMap === null) {
        return sendError(reply, 400, "invalid_property_filter");
      }

      const conditions = [eq(builds.projectId, paramsParsed.data.id)];
      if (queryParsed.data.branch) {
        conditions.push(eq(builds.branchName, queryParsed.data.branch));
      }
      if (Object.keys(propertyMap).length > 0) {
        conditions.push(
          sql`${builds.properties} @> ${JSON.stringify(propertyMap)}::jsonb`,
        );
      }
      if (queryParsed.data.cursor) {
        const c = decodeCursor(queryParsed.data.cursor);
        if (c) {
          conditions.push(
            sql`(${builds.createdAt}, ${builds.id}) < (${c.createdAt}, ${c.id})`,
          );
        }
      }

      return withRequestScope(
        app,
        req,
        async (db) => {
          const rows = await db
            .select()
            .from(builds)
            .where(and(...conditions))
            .orderBy(desc(builds.createdAt), desc(builds.id))
            .limit(queryParsed.data.limit + 1);

          const hasMore = rows.length > queryParsed.data.limit;
          const items = hasMore ? rows.slice(0, queryParsed.data.limit) : rows;
          const last = items[items.length - 1];
          const nextCursor =
            hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
          return { items, nextCursor };
        },
        paramsParsed.data.id,
      );
    },
  );

  app.post(
    "/projects/:id/builds",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("write", { from: { params: "id" } }),
      ],
    },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      const paramsParsed = paramsId.safeParse(req.params);
      if (!paramsParsed.success) {
        return sendError(reply, 404, "not_found");
      }
      const bodyParsed = createBody.safeParse(req.body);
      if (!bodyParsed.success) {
        return sendError(reply, 400, "invalid_body");
      }
      const { ciBuildId, number, branchName, name, properties } =
        bodyParsed.data;

      return withRequestScope(
        app,
        req,
        async (db, onCommit) => {
          // Existence check: requireProjectMember admin-bypasses for the auth
          // role, so a stale/wrong projectId from a client (e.g. the SDK
          // pointing at a deleted project, common in dev after a test wipe)
          // would otherwise flow straight into the insert and trip a FK
          // violation that surfaces as an opaque 500. Return a structured 404
          // instead so the SDK can surface "no such project" upstream.
          const projectRow = await db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, paramsParsed.data.id))
            .limit(1);
          if (!projectRow[0]) {
            return sendError(reply, 404, "project_not_found");
          }

          const start = process.hrtime.bigint();
          let result: { row: Record<string, unknown>; inserted: boolean };
          // Path A: no ciBuildId → unconditional insert (no build id supplied
          // always starts a new batch).
          if (!ciBuildId) {
            const [created] = await db
              .insert(builds)
              .values({
                projectId: paramsParsed.data.id,
                userId: req.auth!.id,
                isRunning: true,
                ciBuildId: null,
                number,
                branchName,
                name,
                properties: properties ?? {},
              })
              .returning();
            if (!created) {
              throw new Error("insert returned no row");
            }
            result = { row: created, inserted: true };
          } else {
            // Path B: ciBuildId present → find-or-create via onConflictDoUpdate
            // against the partial UNIQUE index. `xmax = 0` distinguishes the
            // INSERT path (insert) from the UPDATE path (reattach).
            const rows = await db
              .insert(builds)
              .values({
                projectId: paramsParsed.data.id,
                userId: req.auth!.id,
                isRunning: true,
                ciBuildId,
                number,
                branchName,
                name,
                properties: properties ?? {},
              })
              .onConflictDoUpdate({
                target: [builds.projectId, builds.ciBuildId],
                targetWhere: sql`${builds.ciBuildId} IS NOT NULL`,
                set: {
                  name: sql`coalesce(${builds.name}, excluded.name)`,
                  number: sql`coalesce(${builds.number}, excluded.number)`,
                  branchName: sql`coalesce(${builds.branchName}, excluded.branch_name)`,
                  properties: sql`${builds.properties} || excluded.properties`,
                  updatedAt: sql`now()`,
                },
              })
              .returning({
                id: builds.id,
                ciBuildId: builds.ciBuildId,
                number: builds.number,
                branchName: builds.branchName,
                status: builds.status,
                name: builds.name,
                properties: builds.properties,
                projectId: builds.projectId,
                userId: builds.userId,
                isRunning: builds.isRunning,
                environment: builds.environment,
                createdAt: builds.createdAt,
                updatedAt: builds.updatedAt,
                inserted: sql<boolean>`(xmax = 0)`,
              });
            const row = rows[0];
            if (!row) {
              throw new Error("onConflictDoUpdate returned no row");
            }
            result = { row, inserted: row.inserted };
          }

          const row = result.row;
          const durationMs =
            Number(process.hrtime.bigint() - start) / 1_000_000;
          recordBuildCreate(app.telemetry.metrics, {
            outcome: result.inserted ? "created" : "reattached",
            durationMs,
            propertiesCount: Object.keys(
              (row.properties as Record<string, unknown>) ?? {},
            ).length,
          });

          req.log.info(
            {
              buildId: row.id,
              ciBuildId: row.ciBuildId,
              outcome: result.inserted ? "created" : "reattached",
              durationMs,
            },
            "builds.create",
          );

          // Strip the `inserted` sentinel from the response body when present
          // (Path B). Path A returns a plain insert without the sentinel.
          const body =
            "inserted" in row
              ? (({ inserted: _drop, ...rest }) => rest)(
                  row as typeof row & { inserted: boolean },
                )
              : row;

          // Project SSE broadcast — `build_created` on path A or onConflict-
          // INSERT path B, `build_updated` on onConflict-UPDATE (reattach).
          // Best-effort; deferred to post-commit so a consumer refetch sees
          // the new build row.
          onCommit(() =>
            app.broadcaster.publishProjectEvent(paramsParsed.data.id, {
              event: result.inserted ? "build_created" : "build_updated",
              data: result.inserted ? body : { id: row.id },
            }),
          );

          // Set status + RETURN the body so Fastify sends it AFTER the scope
          // commits (SDK create-build → create-run must not race the commit).
          reply.code(result.inserted ? 201 : 200);
          return body;
        },
        paramsParsed.data.id,
      );
    },
  );
}
