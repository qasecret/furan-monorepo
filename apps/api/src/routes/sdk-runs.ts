import { randomUUID } from "node:crypto";

import {
  and,
  builds,
  eq,
  screenshots,
  testRuns,
  testVariations,
  withProjectScope,
} from "@furan/db";
import { createStorage, objectKey } from "@furan/storage";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";

export const createRunBody = z.object({
  projectId: z.string().uuid(),
  buildId: z.string().uuid(),
  branchName: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  testVariationId: z.string().uuid().optional(),
  browser: z.string().max(32).optional(),
  device: z.string().max(64).optional(),
  os: z.string().max(64).optional(),
  viewport: z.string().max(32).optional(),
  customTags: z.string().max(1024).optional(),
});

export const screenshotsParams = z.object({ runId: z.string().uuid() });

export const createRunResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  projectId: z.string().uuid(),
  testVariationId: z.string().uuid(),
  buildId: z.string().uuid(),
  branchName: z.string(),
  browser: z.string().nullable(),
  viewport: z.string().nullable(),
  status: z.string(),
  createdAt: z.date(),
});

export const uploadScreenshotForm = z.object({
  pngBytes: z
    .string()
    .openapi({ type: "string", format: "binary" })
    .describe("PNG screenshot bytes. Max 50 MB. Required."),
  domHtml: z
    .string()
    .openapi({ type: "string", format: "binary" })
    .optional()
    .describe("Optional captured DOM HTML, used by L2 diff."),
  name: z
    .string()
    .optional()
    .describe("Snapshot name (logged for traceability)."),
  viewport: z
    .string()
    .optional()
    .describe("Viewport string e.g. `1280x720`. Defaults to run viewport."),
  browser: z
    .string()
    .optional()
    .describe("Browser id. Defaults to run browser."),
});

export const uploadScreenshotResponse = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  projectId: z.string().uuid(),
  imageKey: z
    .string()
    .describe("sha256 hex of PNG bytes (content-addressed storage key)."),
  domKey: z.string().nullable(),
  viewport: z.string(),
  browser: z.string(),
  createdAt: z.date().nullable(),
});

export const telemetryBody = z
  .record(z.string(), z.unknown())
  .describe(
    "Anonymous SDK telemetry payload — server logs only, no validation.",
  );

// Defensible deviation: bytes cap for a single PNG is enforced by the
// @fastify/multipart `limits.fileSize` registration in app.ts (50 MB). DOM HTML
// is also size-limited transitively. We accept either a file part `domHtml`
// (preferred for binary safety) or a field with the same name.
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;

/**
 * SDK-facing REST routes (Task 4 of Phase 4):
 *  - POST /runs                          create a test run
 *  - POST /runs/:runId/screenshots       multipart upload (PNG + optional DOM)
 *  - POST /_telemetry/sdk                anonymous SDK telemetry sink (204)
 *
 * Routes intentionally omit the `/api/v1` URL prefix to align with the
 * established API convention (`/auth/login`, `/projects/:id/builds`, etc).
 * The SDK transport calls these paths directly (see FuranClient.kt).
 */
export async function registerSdkRoutes(app: FastifyInstance): Promise<void> {
  // Lazy storage handle — instantiated on first request so app boot does not
  // require S3 credentials in environments that don't exercise this route.
  let storageSingleton: ReturnType<typeof createStorage> | null = null;
  const storage = (): ReturnType<typeof createStorage> => {
    if (!storageSingleton) storageSingleton = createStorage();
    return storageSingleton;
  };

  // ---------------------------------------------------------------------------
  // POST /runs — create a run (project-scoped, write-action)
  // ---------------------------------------------------------------------------
  app.post(
    "/runs",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("write", { from: { body: "projectId" } }),
      ],
    },
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const parsed = createRunBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const input = parsed.data;

      // FK guard: build must exist + belong to the requested project.
      // (Without this, an invalid buildId trips a 500-class FK error and
      // leaks DB internals in the response.)
      const buildRow = await app.db
        .select({ id: builds.id, projectId: builds.projectId })
        .from(builds)
        .where(eq(builds.id, input.buildId))
        .limit(1);
      if (!buildRow[0] || buildRow[0].projectId !== input.projectId) {
        return reply.code(400).send({ error: "invalid_build" });
      }

      // Resolve-or-create the testVariation when SDK didn't supply one.
      // Lookup key: (projectId, branchName, browser, viewport).
      let testVariationId = input.testVariationId;
      const browser = input.browser ?? "selenium";
      const viewport = input.viewport ?? "1280x720";

      if (!testVariationId) {
        const existing = await app.db
          .select({ id: testVariations.id })
          .from(testVariations)
          .where(
            and(
              eq(testVariations.projectId, input.projectId),
              eq(testVariations.name, input.name),
              eq(testVariations.browser, browser),
              eq(testVariations.viewport, viewport),
            ),
          )
          .limit(1);

        if (existing[0]) {
          testVariationId = existing[0].id;
        } else {
          const [created] = await app.db
            .insert(testVariations)
            .values({
              name: input.name,
              projectId: input.projectId,
              branchName: input.branchName,
              browser,
              viewport,
            })
            .returning({ id: testVariations.id });
          testVariationId = created!.id;
        }
      }

      const row = await withProjectScope(
        app.db,
        input.projectId,
        async (tx) => {
          const [created] = await tx
            .insert(testRuns)
            .values({
              name: input.name,
              projectId: input.projectId,
              testVariationId: testVariationId!,
              buildId: input.buildId,
              branchName: input.branchName,
              browser,
              viewport,
              status: "new",
            })
            .returning();
          return created!;
        },
      );

      return reply.code(200).send(row);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /runs/:runId/screenshots — multipart upload of PNG + optional DOM HTML
  // ---------------------------------------------------------------------------
  app.post(
    "/runs/:runId/screenshots",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("write", {
          from: {
            resolver: async (req: FastifyRequest) => {
              const parsed = screenshotsParams.safeParse(req.params);
              if (!parsed.success) return null;
              const row = await app.db
                .select({ projectId: testRuns.projectId })
                .from(testRuns)
                .where(eq(testRuns.id, parsed.data.runId))
                .limit(1);
              return row[0]?.projectId ?? null;
            },
          },
        }),
      ],
    },
    async (req, reply) => {
      const parsedParams = screenshotsParams.safeParse(req.params);
      if (!parsedParams.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const { runId } = parsedParams.data;

      const runRows = await app.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, runId))
        .limit(1);
      const run = runRows[0];
      if (!run) {
        return reply.code(404).send({ error: "run_not_found" });
      }

      // Drain multipart parts. Field order is unconstrained — SDK sends both
      // file parts (pngBytes, optional domHtml) and string fields (name,
      // viewport, browser) in a single iteration. The `name` field is logged
      // for traceability; the screenshots table has no name column today.
      let pngBytes: Buffer | null = null;
      let domHtml: string | null = null;
      let snapName = "snapshot";
      let viewport = run.viewport ?? "1280x720";
      let browser = run.browser ?? "selenium";

      try {
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === "file") {
            const buf = await part.toBuffer();
            if (buf.length > MAX_SCREENSHOT_BYTES) {
              return reply.code(413).send({ error: "payload_too_large" });
            }
            if (part.fieldname === "pngBytes") {
              pngBytes = buf;
            } else if (part.fieldname === "domHtml") {
              domHtml = buf.toString("utf8");
            }
          } else {
            // part.type === "field"
            const value =
              typeof part.value === "string"
                ? part.value
                : String(part.value ?? "");
            if (part.fieldname === "name") snapName = value;
            else if (part.fieldname === "viewport") viewport = value;
            else if (part.fieldname === "browser") browser = value;
            else if (part.fieldname === "domHtml" && !domHtml) domHtml = value;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "multipart_parse_failed");
        return reply.code(400).send({ error: "invalid_multipart" });
      }

      if (!pngBytes) {
        return reply.code(400).send({ error: "pngBytes_required" });
      }

      req.log.info(
        {
          runId: run.id,
          name: snapName,
          viewport,
          browser,
          bytes: pngBytes.length,
        },
        "sdk_screenshot_upload",
      );

      const imageKey = objectKey(pngBytes);
      await storage().put(imageKey, pngBytes, "image/png");

      let domKey: string | null = null;
      if (domHtml) {
        const domBuf = Buffer.from(domHtml, "utf8");
        domKey = objectKey(domBuf);
        await storage().put(domKey, domBuf, "text/html");
      }

      const inserted = await withProjectScope(
        app.db,
        run.projectId,
        async (tx) => {
          const result = await tx
            .insert(screenshots)
            .values({
              runId: run.id,
              projectId: run.projectId,
              imageKey,
              domKey,
              viewport,
              browser,
            })
            .onConflictDoNothing({
              target: [screenshots.runId, screenshots.viewport],
            })
            .returning();
          if (result[0]) return result[0];
          // Conflict: load the existing row so the response reflects reality.
          const [existing] = await tx
            .select()
            .from(screenshots)
            .where(
              and(
                eq(screenshots.runId, run.id),
                eq(screenshots.viewport, viewport),
              ),
            )
            .limit(1);
          return existing!;
        },
      );

      return reply.code(200).send({
        id: inserted.id ?? randomUUID(),
        runId: run.id,
        projectId: run.projectId,
        imageKey,
        domKey,
        viewport,
        browser,
        createdAt: inserted.createdAt ?? null,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /_telemetry/sdk — anonymous, unauthenticated, 204 No Content
  // ---------------------------------------------------------------------------
  app.post("/_telemetry/sdk", async (req, reply) => {
    // Body is intentionally unvalidated — accept any JSON the SDK sends. The
    // payload shape is `SdkTelemetryPayload` today, but breaking shape changes
    // from older SDKs must not 4xx (they would surface to the user's test as
    // a logged warning during `furan.close()`).
    req.log.info({ sdk: req.body ?? {} }, "sdk_telemetry");
    return reply.code(204).send();
  });
}
