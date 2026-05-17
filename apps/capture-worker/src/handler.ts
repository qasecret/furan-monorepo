import { screenshots, withProjectScope, type DB } from "@furan/db";
import type { CaptureJob, Viewport } from "@furan/queue";
import { objectKey, type Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import sharp from "sharp";

import { getBrowser } from "./playwright.js";

type Logger = Telemetry["logger"];

export interface HandlerDeps {
  db: DB;
  storage: Storage;
  redis: Redis;
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
): Promise<void> {
  const t0 = Date.now();
  const viewports: Viewport[] =
    data.viewports && data.viewports.length > 0
      ? data.viewports
      : [data.viewport ?? DEFAULT_VIEWPORT];

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

      await withProjectScope(deps.db, data.projectId, async (tx) => {
        await tx
          .insert(screenshots)
          .values({
            runId: data.runId,
            projectId: data.projectId,
            imageKey,
            domKey,
            viewport: viewportStr,
            browser: data.browser,
          })
          .onConflictDoNothing({ target: screenshots.imageKey });
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
