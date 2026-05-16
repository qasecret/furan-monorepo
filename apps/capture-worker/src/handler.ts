import { screenshots, withProjectScope, type DB } from "@furan/db";
import type { CaptureJob } from "@furan/queue";
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

/**
 * Phase 2 capture handler: launches Playwright, navigates to the target URL,
 * captures a full-page screenshot + DOM, encodes the image as lossless WebP,
 * writes both blobs to content-addressed storage, inserts a `screenshots`
 * row, and publishes `capture.started` / `capture.completed` events on the
 * per-run Redis pub/sub channel.
 */
export async function handleCaptureJob(
  data: CaptureJob,
  logger: Logger,
  deps: HandlerDeps,
): Promise<void> {
  const t0 = Date.now();
  await deps.redis.publish(
    `run:${data.runId}:events`,
    JSON.stringify({
      type: "capture.started",
      runId: data.runId,
      viewport: data.viewport,
      browser: data.browser,
    }),
  );

  const browser = await getBrowser(data.browser);
  const ctx = await browser.newContext({ viewport: data.viewport });
  const page = await ctx.newPage();
  try {
    await page.goto(data.url, { waitUntil: "networkidle", timeout: 30_000 });
    const screenshotBuf = await page.screenshot({
      fullPage: true,
      type: "png",
    });
    const webp = await sharp(screenshotBuf).webp({ lossless: true }).toBuffer();
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
          viewport: `${data.viewport.width}x${data.viewport.height}`,
          browser: data.browser,
        })
        .onConflictDoNothing({ target: screenshots.imageKey });
    });

    const durationMs = Date.now() - t0;
    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "capture.completed",
        runId: data.runId,
        imageKey,
        durationMs,
      }),
    );
    logger.info(
      {
        jobType: "capture",
        runId: data.runId,
        projectId: data.projectId,
        imageKey,
        durationMs,
      },
      "capture_completed",
    );
  } finally {
    await ctx.close();
  }
}
