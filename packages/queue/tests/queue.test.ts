import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createQueue,
  createWorker,
  type Queue,
  type Worker,
} from "../src/index.js";

describe("@furan/queue", () => {
  let queue: Queue;
  let worker: Worker | undefined;

  beforeAll(() => {
    process.env.REDIS_URL ??= "redis://localhost:6379";
    queue = createQueue("capture");
  });

  afterAll(async () => {
    if (worker) await worker.close();
    await queue.close();
  });

  test("enqueue → consume round-trip with typed data", async () => {
    const received: Array<{ projectId: string; runId: string }> = [];

    worker = createWorker("capture", async (job) => {
      received.push({ projectId: job.data.projectId, runId: job.data.runId });
    });

    await queue.add("capture-job", {
      runId: "00000000-0000-0000-0000-000000000001",
      projectId: "00000000-0000-0000-0000-000000000002",
      buildId: "00000000-0000-0000-0000-000000000003",
      testVariationId: "00000000-0000-0000-0000-000000000004",
      url: "https://example.com",
      viewport: { width: 1280, height: 800 },
      browser: "chromium",
    });

    for (let i = 0; i < 50; i++) {
      if (received.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(received).toEqual([
      {
        projectId: "00000000-0000-0000-0000-000000000002",
        runId: "00000000-0000-0000-0000-000000000001",
      },
    ]);
  });

  test("type narrowing rejects wrong job shape (compile-time)", () => {
    // @ts-expect-error — DiffJob shape on capture queue must be rejected
    void (async () =>
      queue.add("wrong", { baselineKey: "x", candidateKey: "y" }));
  });
});
