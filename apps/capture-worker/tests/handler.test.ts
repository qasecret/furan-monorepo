import type { CaptureJob } from "@furan/queue";
import { describe, expect, test, vi } from "vitest";

import { handleCaptureJob } from "../src/handler.js";

describe("capture handler (no-op)", () => {
  test("logs the job fields and resolves", async () => {
    const logger = { info: vi.fn() } as unknown as Parameters<
      typeof handleCaptureJob
    >[1];
    const job: CaptureJob = {
      runId: "r1",
      projectId: "p1",
      buildId: "b1",
      testVariationId: "v1",
      url: "https://example.com",
      viewport: { width: 1280, height: 800 },
      browser: "chromium",
    };
    await expect(handleCaptureJob(job, logger)).resolves.toBeUndefined();
    const calls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toMatchObject({
      jobType: "capture",
      projectId: "p1",
      runId: "r1",
      browser: "chromium",
    });
  });
});
