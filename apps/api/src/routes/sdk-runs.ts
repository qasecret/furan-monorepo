import {
  and,
  baselines,
  builds,
  eq,
  isNull,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";
import { createStorage, objectKey } from "@furan/storage";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { recordElementMapOutcome } from "../lib/screenshot-metrics.js";

// ADR-038: POST /runs creates a test run; checkpoint identity (name,
// viewport, browser, os, device) moves to POST /runs/:id/screenshots.
//
// Legacy v1.0.x shape included viewport/browser/os/device + a name
// field that meant "checkpoint name". Back-compat synthesis for that
// shape lives in Phase 7 (sdk-runs-back-compat.ts) — for now, the
// strict v1.1.0 shape is the only path through this handler.
export const createRunBody = z.object({
  projectId: z.string().uuid(),
  buildId: z.string().uuid(),
  name: z.string().min(1).max(255),
  branchName: z.string().min(1).max(255),
});

export const createRunResponse = z.object({
  runId: z.string().uuid(),
  status: z.string(),
  name: z.string(),
});

export const screenshotsParams = z.object({ runId: z.string().uuid() });

// ---------------------------------------------------------------------------
// Screenshot / checkpoint schemas (Task 2.2)
// ---------------------------------------------------------------------------

const regionRect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
const floatingRect = regionRect.extend({
  maxUpOffset: z.number().optional(),
  maxDownOffset: z.number().optional(),
  maxLeftOffset: z.number().optional(),
  maxRightOffset: z.number().optional(),
});
const accessibilityRect = regionRect.extend({
  type: z.enum(["LargeText", "RegularText", "BoldText", "GraphicalObject"]),
});

export const screenshotFields = z.object({
  name: z.string().min(1).max(255),
  viewport: z.string().min(1).max(64),
  browser: z.string().min(1).max(64),
  os: z.string().max(64).optional().nullable(),
  device: z.string().max(64).optional().nullable(),
  matchLevel: z
    .enum(["Strict", "Layout", "Content", "IgnoreColors", "Dynamic"])
    .default("Strict"),
  regions: z
    .object({
      ignore: z.array(regionRect).default([]),
      layout: z.array(regionRect).default([]),
      floating: z.array(floatingRect).default([]),
      content: z.array(regionRect).default([]),
      accessibility: z.array(accessibilityRect).default([]),
    })
    .default({
      ignore: [],
      layout: [],
      floating: [],
      content: [],
      accessibility: [],
    }),
});

export const screenshotResponse = z.object({
  screenshotId: z.string().uuid(),
  checkpointId: z.string().uuid(),
  testVariationId: z.string().uuid(),
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
    .describe(
      "Checkpoint name (required in v1.1+ shape; logged for traceability).",
    ),
  viewport: z.string().optional().describe("Viewport string e.g. `1280x720`."),
  browser: z.string().optional().describe("Browser id."),
});

export const uploadScreenshotResponse = z.object({
  screenshotId: z.string().uuid(),
  checkpointId: z.string().uuid(),
  testVariationId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// resolveOrCreateVariation — top-level export so runs-lifecycle can reuse it
// ---------------------------------------------------------------------------

/**
 * Looks up a test_variations row by (projectId, branchName, name, viewport,
 * browser, os, device) and returns it, or inserts + returns a new row if
 * none exists. The lookup is intentionally NOT wrapped in a single
 * INSERT … ON CONFLICT because the combination column set is large and we
 * don't want to add a composite unique index for now (Phase 6 will).
 */
export async function resolveOrCreateVariation(
  db: DB,
  params: {
    projectId: string;
    branchName: string;
    name: string;
    viewport: string;
    browser: string;
    os: string | null;
    device: string | null;
  },
): Promise<{ id: string }> {
  const { projectId, branchName, name, viewport, browser, os, device } = params;
  const conditions = [
    eq(testVariations.projectId, projectId),
    eq(testVariations.name, name),
    eq(testVariations.browser, browser),
    eq(testVariations.viewport, viewport),
  ];
  if (branchName) conditions.push(eq(testVariations.branchName, branchName));
  if (os) conditions.push(eq(testVariations.os, os));
  if (device) conditions.push(eq(testVariations.device, device));

  const existing = await db
    .select({ id: testVariations.id })
    .from(testVariations)
    .where(and(...conditions))
    .limit(1);

  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(testVariations)
    .values({
      projectId,
      branchName,
      name,
      viewport,
      browser,
      os: os ?? undefined,
      device: device ?? undefined,
    })
    .returning({ id: testVariations.id });
  return created!;
}

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
   * Persist a screenshot upload's bytes + sidecars, resolve/create the
   * test_variation, insert the checkpoint row, and enqueue a diff job.
   *
   * ADR-038 v1.1.0 path: screenshot rows carry checkpoint identity
   * (name, viewport, browser, os, device, matchLevel, regions). The run
   * row no longer holds viewport/browser/os/device — those live on the
   * test_variation and the screenshot.
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
      os?: string | null;
      device?: string | null;
      matchLevel?: string;
      regions?: {
        ignore: unknown[];
        layout: unknown[];
        floating: unknown[];
        content: unknown[];
        accessibility: unknown[];
      };
    },
    logger: FastifyRequest["log"],
  ) {
    const {
      pngBytes,
      domHtml,
      elementMapRaw,
      snapName,
      viewport,
      browser,
      os = null,
      device = null,
      matchLevel = "Strict",
      regions = {
        ignore: [],
        layout: [],
        floating: [],
        content: [],
        accessibility: [],
      },
    } = inputs;

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

    const hashedImageKey = objectKey(pngBytes);
    await storage().put(hashedImageKey, pngBytes, "image/png");

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
          {
            runId: run.id,
            imageKey: hashedImageKey,
            bytes: elementMapRaw.length,
          },
          "element_map_too_large_dropped",
        );
        recordElementMapOutcome(app.telemetry.metrics, "too_large");
      } else {
        try {
          JSON.parse(elementMapRaw);
          const candidateKey = `${hashedImageKey}.elements.json`;
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
          logger.warn(
            { runId: run.id, imageKey: hashedImageKey, err },
            "element_map_dropped",
          );
          recordElementMapOutcome(app.telemetry.metrics, outcome);
        }
      }
    }

    // ADR-038: resolve-or-create the test variation by checkpoint identity.
    const variation = await resolveOrCreateVariation(app.db, {
      projectId: run.projectId,
      branchName: run.branchName ?? "",
      name: snapName,
      viewport,
      browser,
      os,
      device,
    });

    const screenshotValues = {
      runId: run.id,
      projectId: run.projectId,
      testVariationId: variation.id,
      name: snapName,
      viewport,
      browser,
      os: os ?? undefined,
      device: device ?? undefined,
      matchLevel,
      imageKey: hashedImageKey,
      domKey: domKey ?? undefined,
      elementMapKey: elementMapKey ?? undefined,
      ignoreRegions: regions.ignore.length ? regions.ignore : undefined,
      layoutRegions: regions.layout.length ? regions.layout : undefined,
      floatingRegions: regions.floating.length ? regions.floating : undefined,
      contentRegions: regions.content.length ? regions.content : undefined,
      accessibilityRegions: regions.accessibility.length
        ? regions.accessibility
        : undefined,
    };
    const [screenshot] = await app.db
      .insert(screenshots)
      .values(screenshotValues)
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.name, screenshots.viewport],
      })
      .returning({ id: screenshots.id });

    if (!screenshot) {
      // Duplicate (runId, name, viewport) — return the existing row.
      const [existing] = await app.db
        .select({
          id: screenshots.id,
          testVariationId: screenshots.testVariationId,
        })
        .from(screenshots)
        .where(
          and(
            eq(screenshots.runId, run.id),
            eq(screenshots.name, snapName),
            eq(screenshots.viewport, viewport),
          ),
        )
        .limit(1);
      return {
        screenshotId: existing!.id,
        checkpointId: existing!.id,
        testVariationId: existing!.testVariationId,
        imageKey: hashedImageKey,
        domKey,
        viewport,
        browser,
        runId: run.id,
        projectId: run.projectId,
        createdAt: null as Date | null,
      };
    }

    // Increment checkpoint counter on the run.
    await app.db
      .update(testRuns)
      .set({ checkpointCount: sql`${testRuns.checkpointCount} + 1` })
      .where(eq(testRuns.id, run.id));

    // Best-effort diff enqueue.
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

    // ADR-038: notify the dashboard's diff-viewer SSE channel so open pages
    // can refresh live when a new checkpoint arrives. Best-effort — same
    // failure semantics as the diff enqueue above.
    await app.broadcaster.publishRunEvent?.({
      type: "run.checkpoint_added",
      runId: run.id,
      payload: {
        checkpointId: screenshot.id,
        name: snapName,
        viewport,
      },
    });

    return {
      screenshotId: screenshot.id,
      checkpointId: screenshot.id,
      testVariationId: variation.id,
      // Keep legacy fields in the response so existing tests still pass
      imageKey: hashedImageKey,
      domKey,
      viewport,
      browser,
      runId: run.id,
      projectId: run.projectId,
      createdAt: null as Date | null,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /runs — create a test run (ADR-038 v1.1.0 shape)
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
      const parsed = createRunBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const input = parsed.data;

      // FK guard: build must exist + belong to the requested project.
      const buildRow = await app.db
        .select({ id: builds.id, projectId: builds.projectId })
        .from(builds)
        .where(eq(builds.id, input.buildId))
        .limit(1);
      if (!buildRow[0] || buildRow[0].projectId !== input.projectId) {
        return reply.code(400).send({ error: "invalid_build" });
      }

      const [row] = await app.db
        .insert(testRuns)
        .values({
          projectId: input.projectId,
          buildId: input.buildId,
          name: input.name,
          branchName: input.branchName,
          status: "running",
        })
        .returning({
          id: testRuns.id,
          status: testRuns.status,
          name: testRuns.name,
        });

      if (!row) {
        return reply.code(500).send({ error: "run_insert_failed" });
      }

      // Project SSE broadcast.
      await app.broadcaster.publishProjectEvent(input.projectId, {
        event: "testRun_created",
        data: { id: row.id },
      });
      await app.broadcaster.publishProjectEvent(input.projectId, {
        event: "build_updated",
        data: { id: input.buildId },
      });

      return reply
        .code(201)
        .send({ runId: row.id, status: row.status, name: row.name });
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
      // viewport, browser, os, device, matchLevel) in a single iteration.
      let pngBytes: Buffer | null = null;
      let domHtml: string | null = null;
      let elementMapRaw: string | null = null;
      let snapName = "snapshot";
      let viewport = "1280x720";
      let browser = "selenium";
      let os: string | null = null;
      let device: string | null = null;
      let matchLevel = "Strict";

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
            else if (part.fieldname === "os") os = value || null;
            else if (part.fieldname === "device") device = value || null;
            else if (part.fieldname === "matchLevel") matchLevel = value;
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
        {
          pngBytes,
          domHtml,
          elementMapRaw,
          snapName,
          viewport,
          browser,
          os,
          device,
          matchLevel,
        },
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
      const viewport = body.viewport ?? "1280x720";
      const browser = body.browser ?? "selenium";
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
