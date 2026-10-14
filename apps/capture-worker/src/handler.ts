import {
  and,
  eq,
  isNull,
  screenshots,
  testRuns,
  withProjectScope,
  type DB,
} from "@furan/db";
import type { CaptureJob, Viewport } from "@furan/queue";
import { objectKey, type Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import sharp from "sharp";

import { getBrowser } from "./playwright.js";
import { assertSafeCaptureUrl } from "./url-guard.js";

type Logger = Telemetry["logger"];

export interface HandlerDeps {
  db: DB;
  storage: Storage;
  redis: Redis;
  /** SSRF guard: also reject loopback/RFC-1918/ULA targets (default false —
   *  internal-app capture is a legitimate self-host use case). */
  blockPrivateIps?: boolean;
}

/** Where this call sits in the job's BullMQ retry budget. */
export interface CaptureAttempt {
  /**
   * True when no retry follows if this attempt throws (`isFinalAttempt` from
   * `@furan/queue`). Only the final attempt marks the run `aborted`.
   */
  finalAttempt: boolean;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };

/**
 * Phase 2 capture handler (v0.5 multi-viewport): launches Playwright, and for
 * each viewport in `data.viewports` (or `[data.viewport ?? 1280x720]` for
 * backwards compat), navigates to the target URL, captures a full-page
 * screenshot + DOM, encodes the image as lossless WebP, writes both blobs to
 * content-addressed storage, and inserts a `screenshots` row tagged with the
 * `WxH` viewport string. Publishes one `capture.started` event per viewport
 * and a single trailing `capture.completed` event with the total
 * viewport count + duration.
 */
export async function handleCaptureJob(
  data: CaptureJob,
  logger: Logger,
  deps: HandlerDeps,
  // Callers that don't track retries (tests, scripts) get the safe default: a
  // failure is terminal and the run is marked `aborted`.
  attempt: CaptureAttempt = { finalAttempt: true },
): Promise<void> {
  try {
    await handleCaptureJobInner(data, logger, deps);
  } catch (err) {
    // Ruling R10: BullMQ retries a non-final attempt, so leave the run as it
    // is (`running`) and let the retry carry it forward. `aborted` is a
    // lifecycle state `recomputeRunStatus` keeps, so writing it here would
    // stick even after the retry captures successfully. Rethrow so BullMQ
    // schedules the retry (server.ts logs the failure at warn).
    if (!attempt.finalAttempt) throw err;
    // Final attempt: best-effort terminal status write so a crashed capture
    // does not hang the run in `running` indefinitely. Per spec §3.2 worker
    // exceptions land as `aborted` (distinct from reviewer-rejected
    // `failed`). Wrap in its own try/catch so a status-write failure
    // does not mask the original error.
    try {
      await withProjectScope(deps.db, data.projectId, async (tx) => {
        await tx
          .update(testRuns)
          .set({ status: "aborted" })
          .where(eq(testRuns.id, data.runId));
      });
    } catch (statusErr) {
      logger.error(
        { err: statusErr, runId: data.runId },
        "failed_to_write_aborted_status",
      );
    }
    // Best-effort `run.completed` publish so the integrations subscriber
    // (GitHub commit-status, Slack notifier, outbound webhooks) reacts to
    // the aborted terminal state. The diff-worker normally publishes
    // `run.completed` on the happy path, but a capture-side abort means
    // the diff-worker never runs — so this is the only chance to notify.
    // Wrap in its own try/catch — a publish failure must not mask the
    // worker's original error.
    try {
      await deps.redis.publish(
        `run:${data.runId}:events`,
        JSON.stringify({
          type: "run.completed",
          runId: data.runId,
          projectId: data.projectId,
          status: "aborted",
        }),
      );
    } catch (publishErr) {
      logger.error(
        { err: publishErr, runId: data.runId },
        "failed_to_publish_aborted_run_completed",
      );
    }
    throw err;
  }
}

async function handleCaptureJobInner(
  data: CaptureJob,
  logger: Logger,
  deps: HandlerDeps,
): Promise<void> {
  const t0 = Date.now();
  // An explicit empty `viewports: []` is honored as "no viewports to
  // capture" — exercising the spec §3.2 `empty` terminal state below.
  // When `viewports` is undefined (the common case), fall back to the
  // legacy single-viewport field (or the default 1280x720).
  const viewports: Viewport[] = data.viewports
    ? data.viewports
    : [data.viewport ?? DEFAULT_VIEWPORT];

  // SSRF guard: vet the target before pointing a real browser at it. Same URL
  // across viewports, so check once up front. Throws SsrfBlockedError, which
  // the outer handler turns into an `aborted` run.
  await assertSafeCaptureUrl(data.url, {
    ...(deps.blockPrivateIps !== undefined
      ? { blockPrivate: deps.blockPrivateIps }
      : {}),
  });

  const browser = await getBrowser(data.browser);
  const imageKeys: string[] = [];

  for (const vp of viewports) {
    const viewportStr = `${vp.width}x${vp.height}`;
    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "capture.started",
        runId: data.runId,
        viewport: vp,
        browser: data.browser,
      }),
    );

    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      ...(vp.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: vp.deviceScaleFactor }
        : {}),
    });
    const page = await ctx.newPage();
    try {
      await page.goto(data.url, { waitUntil: "networkidle", timeout: 30_000 });
      const screenshotBuf = await page.screenshot({
        fullPage: true,
        type: "png",
      });
      const webp = await sharp(screenshotBuf)
        .webp({ lossless: true })
        .toBuffer();
      const domSnapshot = await page.content();
      const domBuf = Buffer.from(domSnapshot);

      const imageKey = objectKey(webp);
      const domKey = objectKey(domBuf);

      await deps.storage.put(imageKey, webp, "image/webp");
      await deps.storage.put(domKey, domBuf, "text/html");

      // Generate a 256×160 thumbnail for inbox row previews.
      // Best-effort: failure must NOT fail the screenshot capture.
      let thumbnailKey: string | null = null;
      try {
        const thumbBuf = await sharp(screenshotBuf)
          .resize({ width: 256, height: 160, fit: "cover" })
          .webp({ quality: 70 })
          .toBuffer();
        thumbnailKey = objectKey(thumbBuf);
        await deps.storage.put(thumbnailKey, thumbBuf, "image/webp");
      } catch (err) {
        logger.warn({ err, runId: data.runId }, "thumbnail_generation_failed");
      }

      await withProjectScope(deps.db, data.projectId, async (tx) => {
        if (thumbnailKey !== null) {
          await tx
            .update(testRuns)
            .set({ thumbnailUrl: thumbnailKey })
            .where(
              and(
                eq(testRuns.id, data.runId),
                isNull(testRuns.thumbnailUrl), // first writer wins — URL stays stable
              ),
            );
        }
        // ADR-038: screenshots now require name + testVariationId.
        // The capture-worker uses the viewport string as the checkpoint name
        // (one checkpoint per viewport) and the job's testVariationId.
        await tx
          .insert(screenshots)
          .values({
            runId: data.runId,
            projectId: data.projectId,
            testVariationId: data.testVariationId,
            name: viewportStr,
            imageKey,
            domKey,
            viewport: viewportStr,
            browser: data.browser,
          })
          .onConflictDoNothing({
            target: [screenshots.runId, screenshots.name, screenshots.viewport],
          });
      });

      imageKeys.push(imageKey);
      logger.info(
        {
          jobType: "capture",
          runId: data.runId,
          projectId: data.projectId,
          imageKey,
          viewport: viewportStr,
        },
        "capture_viewport_completed",
      );
    } finally {
      await ctx.close();
    }
  }

  // Per spec §3.2: a capture run that completed without producing any
  // screenshots (e.g. SDK opened a run but never submitted a checkpoint,
  // or every viewport short-circuited) is `empty` —
  // distinct from `aborted` (worker crashed) and `running` (still in
  // flight). Mark the run terminal here so the diff-worker never picks
  // up a check-less run.
  if (imageKeys.length === 0) {
    await withProjectScope(deps.db, data.projectId, async (tx) => {
      await tx
        .update(testRuns)
        .set({ status: "empty" })
        .where(eq(testRuns.id, data.runId));
    });
    // Best-effort `run.completed` publish so the integrations subscriber
    // (GitHub commit-status, Slack notifier, outbound webhooks) reacts to
    // the empty terminal state. The diff-worker won't run for a
    // zero-screenshot run, so this is the only chance to notify. Wrap in
    // its own try/catch — a publish failure must not abort the capture
    // worker's terminal write path.
    try {
      await deps.redis.publish(
        `run:${data.runId}:events`,
        JSON.stringify({
          type: "run.completed",
          runId: data.runId,
          projectId: data.projectId,
          status: "empty",
        }),
      );
    } catch (publishErr) {
      logger.error(
        { err: publishErr, runId: data.runId },
        "failed_to_publish_empty_run_completed",
      );
    }
    logger.info(
      { runId: data.runId, projectId: data.projectId },
      "capture_completed_empty",
    );
  }

  const durationMs = Date.now() - t0;
  await deps.redis.publish(
    `run:${data.runId}:events`,
    JSON.stringify({
      type: "capture.completed",
      runId: data.runId,
      viewportCount: viewports.length,
      imageKeys,
      durationMs,
    }),
  );
  logger.info(
    {
      jobType: "capture",
      runId: data.runId,
      projectId: data.projectId,
      viewportCount: viewports.length,
      durationMs,
    },
    "capture_completed",
  );
}
