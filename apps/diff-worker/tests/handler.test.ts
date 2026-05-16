import type { DiffJob } from "@furan/queue";
import { describe, expect, test, vi } from "vitest";

import { handleDiffJob } from "../src/handler.js";

describe("diff handler (no-op)", () => {
  test("logs the job fields and resolves", async () => {
    const logger = { info: vi.fn() } as unknown as Parameters<
      typeof handleDiffJob
    >[1];
    const job: DiffJob = {
      runId: "r1",
      projectId: "p1",
      baselineKey: "sha256baseline",
      candidateKey: "sha256candidate",
    };
    await expect(handleDiffJob(job, logger)).resolves.toBeUndefined();
    const calls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toMatchObject({
      jobType: "diff",
      projectId: "p1",
      runId: "r1",
      baselineKey: "sha256baseline",
      candidateKey: "sha256candidate",
    });
  });
});
