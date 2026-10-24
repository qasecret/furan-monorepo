import { Registry } from "@furan/telemetry";
import { describe, expect, test, vi } from "vitest";

import {
  addStepDiffJobs,
  type DiffTrigger,
  type StepDiffJob,
} from "../src/lib/diff-enqueue.js";
import type { DiffQueueProducer } from "../src/trpc/context.js";

import { counterValue } from "./helpers.js";

const ENQUEUED = "furan_diff_jobs_enqueued_total";
const FAILURES = "furan_diff_enqueue_failures_total";

const PAYLOAD = {
  runId: "run-1",
  projectId: "project-1",
  screenshotId: "step-1",
  generation: 3,
};

const steps = (...ids: string[]): StepDiffJob[] =>
  ids.map((screenshotId) => ({ ...PAYLOAD, screenshotId }));

function producer(
  addBulk: DiffQueueProducer["addBulk"] = vi.fn().mockResolvedValue([]),
): DiffQueueProducer {
  return { addBulk };
}

describe("addStepDiffJobs", () => {
  test("adds every job in one bulk, each as a diff job under its step's job id", async () => {
    const registry = new Registry();
    const addBulk = vi.fn<DiffQueueProducer["addBulk"]>().mockResolvedValue([]);
    const jobs = [
      { ...PAYLOAD, parentPrBaseBranch: "develop" },
      { ...PAYLOAD, screenshotId: "step-2", generation: 1 },
    ];

    const refused = await addStepDiffJobs(
      { diffQueue: producer(addBulk), registry },
      "threshold",
      jobs,
    );

    expect(refused).toEqual([]);
    // One round trip. `diffJobId(step, version)`: the id the reconciler
    // looks the job up by.
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk).toHaveBeenCalledWith([
      { name: "diff", data: jobs[0], opts: { jobId: "step-1-g3" } },
      { name: "diff", data: jobs[1], opts: { jobId: "step-2-g1" } },
    ]);
    // Same objects, not rebuilt copies: the wire stays what the caller built.
    expect(addBulk.mock.calls[0]![0][0]!.data).toBe(jobs[0]);
    // Counted by the number of jobs added.
    expect(
      await counterValue(registry, ENQUEUED, { trigger: "threshold" }),
    ).toBe(2);
    expect(
      await counterValue(registry, FAILURES, { trigger: "threshold" }),
    ).toBe(0);
  });

  test("a refused bulk refuses every job in it, each counted as a failure under its trigger", async () => {
    const registry = new Registry();
    const boom = new Error("queue is down");
    const jobs = steps("step-1", "step-2", "step-3");

    const refused = await addStepDiffJobs(
      { diffQueue: producer(vi.fn().mockRejectedValue(boom)), registry },
      "undo",
      jobs,
    );

    // It never rejects: the caller decides what a refusal means.
    expect(refused).toEqual(jobs.map((job) => ({ job, err: boom })));
    expect(await counterValue(registry, FAILURES, { trigger: "undo" })).toBe(3);
    expect(await counterValue(registry, ENQUEUED, { trigger: "undo" })).toBe(0);
  });

  test("an empty list adds nothing and counts nothing", async () => {
    const registry = new Registry();
    const addBulk = vi.fn<DiffQueueProducer["addBulk"]>();

    expect(
      await addStepDiffJobs(
        { diffQueue: producer(addBulk), registry },
        "upload",
        [],
      ),
    ).toEqual([]);
    expect(addBulk).not.toHaveBeenCalled();
    expect(await counterValue(registry, ENQUEUED, { trigger: "upload" })).toBe(
      0,
    );
  });

  test("keeps one series per trigger and accumulates across calls", async () => {
    const registry = new Registry();
    const deps = { diffQueue: producer(), registry };
    const triggers: DiffTrigger[] = [
      "upload",
      "ignore_areas",
      "ignore_areas",
      "temp_ignore_areas",
      "threshold",
      "undo",
      "branch_merge",
      "retry",
      "reconcile",
    ];
    for (const t of triggers) await addStepDiffJobs(deps, t, steps("step-1"));

    expect(
      await counterValue(registry, ENQUEUED, { trigger: "ignore_areas" }),
    ).toBe(2);
    for (const t of [
      "upload",
      "temp_ignore_areas",
      "threshold",
      "undo",
      "branch_merge",
      "retry",
      "reconcile",
    ]) {
      expect(await counterValue(registry, ENQUEUED, { trigger: t })).toBe(1);
    }
  });

  test("a registry is registered once, and registries do not share counts", async () => {
    const a = new Registry();
    const b = new Registry();

    // prom-client throws on a duplicate metric name: a second call on the same
    // registry must reuse the counters rather than register them again.
    await addStepDiffJobs(
      { diffQueue: producer(), registry: a },
      "upload",
      steps("step-1"),
    );
    await addStepDiffJobs(
      { diffQueue: producer(), registry: a },
      "upload",
      steps("step-1", "step-2"),
    );
    await addStepDiffJobs(
      { diffQueue: producer(), registry: b },
      "upload",
      steps("step-1"),
    );

    expect(await counterValue(a, ENQUEUED, { trigger: "upload" })).toBe(3);
    expect(await counterValue(b, ENQUEUED, { trigger: "upload" })).toBe(1);
  });

  test("labels carry the trigger only, never an id", async () => {
    const registry = new Registry();
    await addStepDiffJobs(
      { diffQueue: producer(), registry },
      "branch_merge",
      steps("step-1"),
    );

    const { values } = await registry.getSingleMetric(ENQUEUED)!.get();
    expect(
      (values as Array<{ labels: Record<string, unknown> }>).map((v) =>
        Object.keys(v.labels),
      ),
    ).toEqual([["trigger"]]);
  });
});
