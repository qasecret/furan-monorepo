import { randomUUID } from "node:crypto";

import {
  and,
  baselines,
  builds,
  eq,
  isNull,
  screenshots,
  testRuns,
  testVariations,
  withProjectScope,
} from "@furan/db";
import { createStorage, objectKey } from "@furan/storage";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { recordElementMapOutcome } from "../lib/screenshot-metrics.js";

/**
 * Per-run ignore region. Carried inline in POST /runs so SDK consumers
 * can declare ignore regions at run-creation time and the diff worker
 * picks them up on the first diff job — no separate setIgnoreAreas
 * call + re-enqueue cycle. Matches the legacy Java SDK's IgnoreAreas
 * shape verbatim except for the optional `viewport` field (which lets
 * multi-viewport runs apply the right mask per screenshot, same as
 * the dashboard's typed ignore-region schema in `apps/api/src/trpc/v1/runs.ts`).
 */
export const ignoreAreaSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  viewport: z.string().min(1).max(32).optional(),
});

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
  /**
   * Per-run diff tolerance override (0–1 fraction, same units as
   * `projects.diffThreshold`). When set, the diff worker compares
   * against this threshold instead of the project default. Java SDK
   * parity (`diffTollerancePercent` in `TestRunRequest`).
   */
  diffTolerance: z.number().min(0).max(1).optional(),
  /**
   * Per-run ignore regions, applied by the diff worker on the first
   * diff job. Cap matches the dashboard's `addIgnoreAreas` cap
   * (`MAX_IGNORE_REGIONS = 50`); going over is a 400. Subsequent
   * tweaks go through tRPC `runs.setIgnoreAreas`.
   */
  ignoreAreas: z.array(ignoreAreaSchema).max(50).optional(),
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
const MAX_ELEMENT_MAP_BYTES = 1_000_000;

/**
 * JSON body shape for the base64 SDK ingest path. Same semantic content
 * as the multipart variant — PNG + optional DOM + optional element map +
 * trace fields — but bytes are base64-encoded so the whole payload is a
 * single JSON object. Matches the predecessor frontend's `POST
 * /test-runs` shape so SDK scripts porting from the legacy backend don't
 * need to switch transports.
 *
 * Use this path when:
 *  - your HTTP client / CI image makes multipart awkward (some Node
 *    runtimes, restrictive proxies, hand-written curl)
 *  - you're streaming structured data and want a single Content-Type
 *
 * The multipart variant remains the recommended path for production
 * SDK use (no encoding overhead, streamed parsing). Both routes call
 * the same `persistScreenshot` helper after decoding so behavior stays
 * identical end-to-end (same storage path, same diff-queue enqueue, same
 * response shape).
 */
export const uploadScreenshotJsonBody = z.object({
  /** Base64-encoded PNG bytes. ~50 MB raw → ~67 MB encoded. */
  pngBase64: z.string().min(1),
  name: z.string().max(255).optional(),
  viewport: z.string().max(32).optional(),
  browser: z.string().max(32).optional(),
  domHtml: z.string().optional(),
  /** Stringified JSON object — same shape as the multipart field. */
  elementMapJson: z.string().optional(),
});

/**
 * SDK-facing REST routes (Task 4 of Phase 4):
 *  - POST /runs                            create a test run
 *  - POST /runs/:runId/screenshots         multipart upload (PNG + optional DOM)
 *  - POST /runs/:runId/screenshots/base64  JSON body (base64-encoded PNG)
 *  - POST /_telemetry/sdk                  anonymous SDK telemetry sink (204)
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

  /**
   * Persist a screenshot upload's bytes + sidecars and enqueue a diff job.
   *
   * Extracted from the multipart route so the base64 JSON variant can reuse
   * the same downstream behavior — storage paths, element-map JSON
   * validation, `(run_id, viewport)` onConflictDoNothing semantics, and
   * the best-effort diff-queue enqueue from PR #99 all live here, exactly
   * once.
   *
   * Returns the response payload the routes send back; throws on neither
   * caller-fixable nor caller-recoverable errors (the routes have already
   * validated `pngBytes` is non-null and the schema; failures inside the
   * helper are limited to storage/db ones, which surface as 5xx). Queue
   * failures specifically are caught + logged here (not re-thrown), so a
   * Redis blip doesn't fail a successfully-persisted upload.
   */
  async function persistScreenshot(
    run: typeof testRuns.$inferSelect,
    inputs: {
      pngBytes: Buffer;
      domHtml: string | null;
      elementMapRaw: string | null;
      snapName: string;
      viewport: string;
      browser: string;
    },
    logger: FastifyRequest["log"],
  ) {
    const { pngBytes, domHtml, elementMapRaw, snapName, viewport, browser } =
      inputs;

    logger.info(
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

    let elementMapKey: string | null = null;
    if (elementMapRaw !== null) {
      if (elementMapRaw.length > MAX_ELEMENT_MAP_BYTES) {
        logger.warn(
          { runId: run.id, imageKey, bytes: elementMapRaw.length },
          "element_map_too_large_dropped",
        );
        recordElementMapOutcome(app.telemetry.metrics, "too_large");
      } else {
        try {
          JSON.parse(elementMapRaw);
          const candidateKey = `${imageKey}.elements.json`;
          await storage().put(
            candidateKey,
            Buffer.from(elementMapRaw, "utf8"),
            "application/json",
          );
          elementMapKey = candidateKey;
          recordElementMapOutcome(app.telemetry.metrics, "ok");
        } catch (err) {
          const outcome =
            err instanceof SyntaxError ? "invalid_json" : "storage_error";
          logger.warn({ runId: run.id, imageKey, err }, "element_map_dropped");
          recordElementMapOutcome(app.telemetry.metrics, outcome);
        }
      }
    }

    let isNewScreenshot = false;
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
            elementMapKey,
            viewport,
            browser,
          })
          .onConflictDoNothing({
            target: [screenshots.runId, screenshots.viewport],
          })
          .returning();
        if (result[0]) {
          isNewScreenshot = true;
          return result[0];
        }
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

    // PR #99 fix — enqueue the diff job so SDK-uploaded runs leave
    // `running`. Only enqueue when we actually inserted a new screenshot
    // (idempotent retries on the same (runId, viewport) skip the work).
    // Best-effort: queue failures log + return without failing the upload.
    if (isNewScreenshot) {
      try {
        await app.diffQueue.add("diff", {
          runId: run.id,
          projectId: run.projectId,
        });
      } catch (err) {
        logger.warn(
          { err, runId: run.id, projectId: run.projectId },
          "sdk_upload_diff_enqueue_failed",
        );
      }
    }

    return {
      id: inserted.id ?? randomUUID(),
      runId: run.id,
      projectId: run.projectId,
      imageKey,
      domKey,
      viewport,
      browser,
      createdAt: inserted.createdAt ?? null,
    };
  }

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

      // Serialize the inline ignore-areas as JSON for the
      // `test_runs.ignore_areas` text column. Matches the shape the
      // dashboard's `setIgnoreAreas` mutation writes, so downstream
      // tRPC reads + the diff worker see one consistent format.
      const ignoreAreasJson =
        input.ignoreAreas && input.ignoreAreas.length > 0
          ? JSON.stringify(input.ignoreAreas)
          : null;
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
              status: "running",
              // Inline diff-tolerance + ignore-areas land on the
              // initial insert so the first diff job uses them
              // without a separate setIgnoreAreas + re-enqueue trip.
              ...(input.diffTolerance !== undefined
                ? { diffThresholdOverride: input.diffTolerance }
                : {}),
              ...(ignoreAreasJson ? { ignoreAreas: ignoreAreasJson } : {}),
            })
            .returning();
          return created!;
        },
      );

      // Project SSE broadcast — `testRun_created` plus the cascading
      // `build_updated` that legacy mirrors (events.gateway.ts:38). The
      // dashboard's runs index invalidates on the run event; the build
      // detail invalidates its child-run count on the build event.
      await app.broadcaster.publishProjectEvent(input.projectId, {
        event: "testRun_created",
        data: row,
      });
      await app.broadcaster.publishProjectEvent(input.projectId, {
        event: "build_updated",
        data: { id: row.buildId },
      });

      return reply.code(200).send(row);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /runs/:runId — fetch a run by id (parity with POST /runs)
  //
  // SDK clients that poll for a run's terminal status (capture-completed,
  // diff-done, autoApproved) want a thin REST equivalent of the tRPC
  // `runs.getById` procedure. Returns the run row's columns PLUS the
  // derived `autoApproved` flag (true iff a baselines row with a NULL
  // userId exists for this run — same derivation as ADR-032 and the
  // tRPC procedure). The richer dashboard payload (screenshots,
  // diffRegions, baseline resolution) remains tRPC-only.
  //
  // `autoApproved` is derived (not a column) because the diff worker's
  // first-baseline + pixel-identical paths both insert an auto-baseline
  // row (userId IS NULL) without touching test_runs. The SDK's
  // snapshotAndAwait() polling loop reads this field as its "is this
  // run actually done" signal — without it, first-baseline runs poll
  // forever (verified 2026-05-25 in PR #128 CI).
  // ---------------------------------------------------------------------------
  app.get(
    "/runs/:runId",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("read", {
          from: {
            resolver: async (req) => {
              const params = req.params as { runId?: string };
              if (!params.runId) return null;
              const rows = await app.db
                .select({ projectId: testRuns.projectId })
                .from(testRuns)
                .where(eq(testRuns.id, params.runId))
                .limit(1);
              return rows[0]?.projectId ?? null;
            },
          },
        }),
      ],
    },
    async (req, reply) => {
      const params = req.params as { runId?: string };
      if (!params.runId) {
        return reply.code(400).send({ error: "invalid_run_id" });
      }
      const rows = await app.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, params.runId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return reply.code(404).send({ error: "not_found" });
      }
      // Derive autoApproved the same way the tRPC procedure does
      // (apps/api/src/trpc/v1/runs.ts:308–318). One PK-indexed lookup
      // on the baselines table.
      const autoApprovedRows = await app.db
        .select({ id: baselines.id })
        .from(baselines)
        .where(
          and(eq(baselines.testRunId, params.runId), isNull(baselines.userId)),
        )
        .limit(1);
      const autoApproved = autoApprovedRows.length > 0;
      return reply.code(200).send({ ...row, autoApproved });
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
      let elementMapRaw: string | null = null;
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
            } else if (part.fieldname === "elementMapJson") {
              elementMapRaw = buf.toString("utf8");
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
            else if (part.fieldname === "elementMapJson" && !elementMapRaw)
              elementMapRaw = value;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "multipart_parse_failed");
        return reply.code(400).send({ error: "invalid_multipart" });
      }

      if (!pngBytes) {
        return reply.code(400).send({ error: "pngBytes_required" });
      }

      const result = await persistScreenshot(
        run,
        { pngBytes, domHtml, elementMapRaw, snapName, viewport, browser },
        req.log,
      );
      return reply.code(200).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /runs/:runId/screenshots/base64 — JSON body variant of the
  // multipart screenshot upload. Same persistence path; the only
  // difference is wire format.
  //
  // Preserves parity with the predecessor frontend's POST /test-runs API,
  // which accepted base64-encoded image bytes in a JSON body. SDK scripts
  // porting from that backend can hit this route without switching to
  // multipart. New SDK clients should prefer the multipart route — it
  // streams, avoids the ~33% base64 encoding overhead, and uses the same
  // 50 MB limit configured on @fastify/multipart in app.ts.
  // ---------------------------------------------------------------------------
  app.post(
    "/runs/:runId/screenshots/base64",
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

      const parsedBody = uploadScreenshotJsonBody.safeParse(req.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const body = parsedBody.data;

      const runRows = await app.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, runId))
        .limit(1);
      const run = runRows[0];
      if (!run) {
        return reply.code(404).send({ error: "run_not_found" });
      }

      // Decode base64. Node's Buffer.from with "base64" is lenient — it
      // accepts both standard and URL-safe alphabets and silently drops
      // whitespace, so we don't need a separate normalization pass. The
      // decoded length is what we check against the size cap (the upload
      // can have legal padding bytes that don't count against the real
      // image size, but our cap is on decoded bytes so this is correct).
      let pngBytes: Buffer;
      try {
        pngBytes = Buffer.from(body.pngBase64, "base64");
      } catch (err) {
        req.log.warn({ err, runId }, "base64_decode_failed");
        return reply.code(400).send({ error: "invalid_base64" });
      }
      if (pngBytes.length === 0) {
        return reply.code(400).send({ error: "pngBase64_empty" });
      }
      if (pngBytes.length > MAX_SCREENSHOT_BYTES) {
        return reply.code(413).send({ error: "payload_too_large" });
      }

      const snapName = body.name ?? "snapshot";
      const viewport = body.viewport ?? run.viewport ?? "1280x720";
      const browser = body.browser ?? run.browser ?? "selenium";
      const domHtml = body.domHtml ?? null;
      const elementMapRaw = body.elementMapJson ?? null;

      const result = await persistScreenshot(
        run,
        { pngBytes, domHtml, elementMapRaw, snapName, viewport, browser },
        req.log,
      );
      return reply.code(200).send(result);
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
