export type Suite = "pipeline" | "server" | "browser";

/** The slice that is expected to make the budget pass (1 = slice 1, the harness itself). */
export type Owner = 1 | 2 | 3 | 4;

export interface Budget {
  id: string;
  suite: Suite;
  owner: Owner;
  /** `enforced` budgets fail a `large` run; `tracked` ones are reported only. */
  status: "tracked" | "enforced";
  unit: "ms" | "ratio" | "count" | "KB" | "elements";
  compare: "<=" | ">=";
  threshold: number;
  description: string;
}

export interface Measurement {
  id: string;
  value: number | null;
  samples?: number;
  note?: string;
  error?: string;
}

export type Verdict = "pass" | "fail" | "missing" | "error" | "skipped";

export interface Row extends Budget {
  value: number | null;
  verdict: Verdict;
  /** How many samples the value summarises, when the measurement said. */
  samples?: number;
  note?: string;
}

/**
 * Every budget the harness judges, in report order. A budget starts tracked and
 * becomes enforced once a reference run on the CI runner passes it: with at
 * least 20% headroom for a timing (slice 1 Ruling R51), or exactly for a count
 * that has no noise to absorb. The owning slice flips it; `scale/README.md`
 * lists what is enforced and why.
 */
export const BUDGETS: readonly Budget[] = [
  {
    id: "P1",
    suite: "pipeline",
    owner: 2,
    status: "enforced",
    unit: "ratio",
    compare: "<=",
    threshold: 1.0,
    description:
      "Checkpoint diffs per run divided by steps uploaded: diff work is linear, so exactly 1.",
  },
  {
    id: "P2",
    suite: "pipeline",
    owner: 2,
    status: "enforced",
    unit: "ms",
    compare: "<=",
    threshold: 5000,
    description:
      "Upload to that step's result, p95, with an idle queue (50-step run).",
  },
  {
    id: "P3",
    suite: "pipeline",
    owner: 2,
    status: "enforced",
    unit: "ms",
    compare: "<=",
    threshold: 10000,
    description: "Last upload to final run status for the 500-step run.",
  },
  {
    id: "P4",
    suite: "pipeline",
    owner: 2,
    status: "tracked",
    unit: "ratio",
    compare: ">=",
    threshold: 0.8,
    description:
      "Sustained throughput as a share of the worker's ideal (concurrency times the single-step rate).",
  },
  {
    id: "P5",
    suite: "pipeline",
    owner: 2,
    status: "tracked",
    unit: "count",
    compare: "<=",
    threshold: 0,
    description:
      "Duplicate regions, lost regions and lost results (summed) after an upload, an ignore-region save and an undo overlap.",
  },
  {
    id: "P6",
    suite: "pipeline",
    owner: 2,
    status: "enforced",
    unit: "count",
    compare: "<=",
    threshold: 0,
    description:
      "testRun_updated events per run above the allowance of status changes + 2: growth follows status, not steps.",
  },
  {
    id: "R1",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "review.next on its own HTTP call under 20 concurrent reviewers, p95.",
  },
  {
    id: "R1-solo.findNext",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "The queue query behind review.next (findNext), single caller, no HTTP, p95 over 50 calls after warm-up.",
  },
  {
    id: "R1-solo.reviewNext",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "review.next through a server-side caller, single caller, no HTTP, p95 over 50 calls after warm-up.",
  },
  {
    id: "R1-solo.worst",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "Slowest review.next and findNext call on the worst-case project, where every recent batch is resolved.",
  },
  {
    id: "R2.pendingCount",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "builds.pendingCount on its own HTTP call under 20 concurrent reviewers, p95.",
  },
  {
    id: "R2.runsListPending",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "runs.list with the pending filter on the 1,000-run batch, own HTTP call under 20 concurrent reviewers, p95.",
  },
  {
    id: "R2-solo.pendingCount",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "builds.pendingCount, single caller, no HTTP, p95 over 50 calls after warm-up.",
  },
  {
    id: "R2-solo.runsListPending",
    suite: "server",
    owner: 1,
    status: "enforced",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "runs.list with the pending filter, single caller, no HTTP, p95 over 50 calls after warm-up.",
  },
  {
    id: "R2-solo.buildsListNeedsReview",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "builds.list with the needs-review filter, single caller, no HTTP; the guarantee the previous perf script gave.",
  },
  {
    id: "R2-solo.worst",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 50,
    description:
      "Slowest pending-queue procedure on the worst-case project, single caller, no HTTP.",
  },
  {
    id: "R3.buildsList",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 100,
    description: "builds.list, first page, unfiltered.",
  },
  {
    id: "R3.buildsListNeedsReview",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 100,
    description: "builds.list, first page, needs-review filter.",
  },
  {
    id: "R3.runsList",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 100,
    description: "runs.list, first page, unfiltered, on the 1,000-run batch.",
  },
  {
    id: "R4.time",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 250,
    description:
      "Slowest procedure the viewer fetches when opening a step of the 500-step run.",
  },
  {
    id: "R4.size",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "KB",
    compare: "<=",
    threshold: 250,
    description:
      "Decoded JSON of every procedure the viewer fetches on open, combined.",
  },
  {
    id: "R5.buildsGetById",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 100,
    description: "builds.getById on the 1,000-run batch.",
  },
  {
    id: "R5.checkpointGroup",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 100,
    description: "runs.getCheckpointGroup on the 1,000-run batch.",
  },
  {
    id: "R6",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 10,
    description:
      "Storage-proxy access check for a non-admin, server time only, on a key owned by exactly one row.",
  },
  {
    id: "R7",
    suite: "server",
    owner: 3,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 150,
    description: "review.approve of one step.",
  },
  {
    id: "R8",
    suite: "server",
    owner: 1,
    status: "enforced",
    unit: "count",
    compare: "<=",
    threshold: 0,
    description:
      "Failed requests under load: 5xx responses and request-size 4xx responses.",
  },
  {
    id: "D1",
    suite: "browser",
    owner: 1,
    status: "enforced",
    unit: "ms",
    compare: "<=",
    threshold: 1500,
    description:
      "Batches page with 10,000 batches: navigation to first row visible, cold cache.",
  },
  {
    id: "D2.firstRow",
    suite: "browser",
    owner: 4,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 1500,
    description: "Batch page with 1,000 runs: first row visible.",
  },
  {
    id: "D2.domMax",
    suite: "browser",
    owner: 1,
    status: "enforced",
    unit: "elements",
    compare: "<=",
    threshold: 5000,
    description:
      "Most DOM elements at the top, middle and bottom scroll positions of the batch page.",
  },
  {
    id: "D2.offscreenImages",
    suite: "browser",
    owner: 4,
    status: "tracked",
    unit: "count",
    compare: "<=",
    threshold: 0,
    description: "Step images fetched for cards outside the viewport.",
  },
  {
    id: "D2.imageKB",
    suite: "browser",
    owner: 4,
    status: "tracked",
    unit: "KB",
    compare: "<=",
    threshold: 40,
    description: "Largest step image on the batch page, bytes on the wire.",
  },
  {
    id: "D3.calls",
    suite: "browser",
    owner: 4,
    status: "tracked",
    unit: "count",
    compare: "<=",
    threshold: 4,
    description:
      "tRPC procedure calls in the 3 s after approving one step on the batch page.",
  },
  {
    id: "D3.refetches",
    suite: "browser",
    owner: 4,
    status: "tracked",
    unit: "count",
    compare: "<=",
    threshold: 1,
    description:
      "Most refetches of any one visible list after approving one step.",
  },
  {
    id: "D4",
    suite: "browser",
    owner: 4,
    status: "tracked",
    unit: "count",
    compare: "<=",
    threshold: 1,
    description:
      "Refetches of one visible list query per 3 s window while a 500-step run uploads and diffs.",
  },
  {
    id: "D5.open",
    suite: "browser",
    owner: 4,
    status: "tracked",
    unit: "ms",
    compare: "<=",
    threshold: 1500,
    description: "Viewer: first open to the stage's drawn signal.",
  },
  {
    id: "D5.next",
    suite: "browser",
    owner: 1,
    status: "enforced",
    unit: "ms",
    compare: "<=",
    threshold: 300,
    description: "Viewer: next step drawn after the key press, p95.",
  },
];

/**
 * Judges measurements against budgets, one row per budget, in order.
 *
 * - `skipped`: the budget's suite did not run, whatever was measured.
 * - `error`: the measurement carries an error (the suite threw, or the
 *   probe failed), even if it also has a value.
 * - `missing`: the suite ran but produced no usable value.
 * - otherwise `pass` or `fail` by `compare`; the threshold itself passes.
 */
export function evaluate(
  budgets: readonly Budget[],
  measurements: readonly Measurement[],
  suitesRun: readonly Suite[],
): Row[] {
  const byId = new Map<string, Measurement>();
  for (const measurement of measurements) byId.set(measurement.id, measurement);

  return budgets.map((budget): Row => {
    const base = { ...budget, value: null };
    if (!suitesRun.includes(budget.suite)) {
      return { ...base, verdict: "skipped" };
    }
    const measurement = byId.get(budget.id);
    if (measurement?.error !== undefined) {
      return {
        ...base,
        value: measurement.value,
        verdict: "error",
        note: measurement.error,
      };
    }
    const value = measurement?.value;
    if (measurement === undefined || value == null || !Number.isFinite(value)) {
      return {
        ...base,
        verdict: "missing",
        ...(measurement?.note !== undefined && { note: measurement.note }),
      };
    }
    const ok =
      budget.compare === "<="
        ? value <= budget.threshold
        : value >= budget.threshold;
    return {
      ...base,
      value,
      verdict: ok ? "pass" : "fail",
      ...(measurement.samples !== undefined && {
        samples: measurement.samples,
      }),
      ...(measurement.note !== undefined && { note: measurement.note }),
    };
  });
}

/**
 * 1 if the run should fail the caller. A `missing` or `error` row always
 * fails: the harness could not measure what it promised. On a `large` run an
 * `enforced` budget that failed also fails. A `smoke` run exercises the
 * harness on a small shape and never judges thresholds.
 */
export function exitCode(
  rows: readonly Row[],
  shape: "large" | "smoke",
): 0 | 1 {
  for (const row of rows) {
    if (row.verdict === "missing" || row.verdict === "error") return 1;
    if (
      shape === "large" &&
      row.verdict === "fail" &&
      row.status === "enforced"
    ) {
      return 1;
    }
  }
  return 0;
}
