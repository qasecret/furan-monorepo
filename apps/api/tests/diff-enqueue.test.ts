import { Registry } from "@furan/telemetry";
import { describe, expect, test, vi } from "vitest";

import { addDiffJob, type DiffTrigger } from "../src/lib/diff-enqueue.js";
import type { DiffQueueProducer } from "../src/trpc/context.js";

import { counterValue } from "./helpers.js";

const ENQUEUED = "furan_diff_jobs_enqueued_total";
const FAILURES = "furan_diff_enqueue_failures_total";

const PAYLOAD = { runId: "run-1", projectId: "project-1" };

function producer(add: DiffQueueProducer["add"]): DiffQueueProducer {
  return { add };
}

describe("addDiffJob", () => {
  test("counts success and failure by trigger", async () => {
    const registry = new Registry();

    // One success: counted under its trigger, nothing counted as a failure.
    await addDiffJob(
      {
        diffQueue: producer(vi.fn().mockResolvedValue({ id: "job" })),
        registry,
      },
      "upload",
      PAYLOAD,
    );
    expect(await counterValue(registry, ENQUEUED, { trigger: "upload" })).toBe(
      1,
    );
    expect(await counterValue(registry, FAILURES, { trigger: "upload" })).toBe(
      0,
    );

    // A rejecting producer: addDiffJob rejects with the producer's own error,
    // the failure is counted under its trigger, and no success is.
    const boom = new Error("queue is down");
    await expect(
      addDiffJob(
        { diffQueue: producer(vi.fn().mockRejectedValue(boom)), registry },
        "undo",
        PAYLOAD,
      ),
    ).rejects.toBe(boom);
    expect(await counterValue(registry, FAILURES, { trigger: "undo" })).toBe(1);
    expect(await counterValue(registry, ENQUEUED, { trigger: "undo" })).toBe(0);

    // The failure did not move the upload series.
    expect(await counterValue(registry, ENQUEUED, { trigger: "upload" })).toBe(
      1,
    );
    expect(await counterValue(registry, FAILURES, { trigger: "upload" })).toBe(
      0,
    );
  });

  test("hands the payload to the queue unchanged, as a diff job", async () => {
    const registry = new Registry();
    const add = vi.fn().mockResolvedValue({ id: "job" });
    const payload = { ...PAYLOAD, parentPrBaseBranch: "develop" };

    await addDiffJob(
      { diffQueue: producer(add), registry },
      "threshold",
      payload,
    );

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith("diff", payload);
    // Same object, not a rebuilt copy: the wire stays what the caller built.
    expect(add.mock.calls[0]![1]).toBe(payload);
  });

  test("keeps one series per trigger and accumulates across calls", async () => {
    const registry = new Registry();
    const deps = {
      diffQueue: producer(vi.fn().mockResolvedValue({ id: "job" })),
      registry,
    };
    const triggers: DiffTrigger[] = [
      "upload",
      "ignore_areas",
      "ignore_areas",
      "temp_ignore_areas",
      "threshold",
      "undo",
      "branch_merge",
    ];
    for (const t of triggers) await addDiffJob(deps, t, PAYLOAD);

    expect(
      await counterValue(registry, ENQUEUED, { trigger: "ignore_areas" }),
    ).toBe(2);
    for (const t of [
      "upload",
      "temp_ignore_areas",
      "threshold",
      "undo",
      "branch_merge",
    ]) {
      expect(await counterValue(registry, ENQUEUED, { trigger: t })).toBe(1);
    }
  });

  test("a registry is registered once, and registries do not share counts", async () => {
    const a = new Registry();
    const b = new Registry();
    const ok = vi.fn().mockResolvedValue({ id: "job" });

    // prom-client throws on a duplicate metric name: a second call on the same
    // registry must reuse the counters rather than register them again.
    await addDiffJob(
      { diffQueue: producer(ok), registry: a },
      "upload",
      PAYLOAD,
    );
    await addDiffJob(
      { diffQueue: producer(ok), registry: a },
      "upload",
      PAYLOAD,
    );
    await addDiffJob(
      { diffQueue: producer(ok), registry: b },
      "upload",
      PAYLOAD,
    );

    expect(await counterValue(a, ENQUEUED, { trigger: "upload" })).toBe(2);
    expect(await counterValue(b, ENQUEUED, { trigger: "upload" })).toBe(1);
  });

  test("labels carry the trigger only, never an id", async () => {
    const registry = new Registry();
    await addDiffJob(
      {
        diffQueue: producer(vi.fn().mockResolvedValue({ id: "job" })),
        registry,
      },
      "branch_merge",
      PAYLOAD,
    );

    const { values } = await registry.getSingleMetric(ENQUEUED)!.get();
    expect(
      (values as Array<{ labels: Record<string, unknown> }>).map((v) =>
        Object.keys(v.labels),
      ),
    ).toEqual([["trigger"]]);
  });
});
