import type { RunStatus } from "@furan/shared-types";

import { presentationFor } from "./status-mapping.js";

/** How many of a build's tests (their latest run each) are in each status. */
export type RunStatusCounts = Partial<Record<RunStatus, number>>;

export interface BuildStatusAggregate {
  /** The worst status among the build's tests; drives the GitHub state. */
  status: RunStatus;
  total: number;
  /** Tests whose status maps to the same GitHub state as `status`. */
  inBucket: number;
}

/**
 * Worst first. The `furan/baselines` commit status is one value per commit and
 * is meant to gate merges, so it has to reflect the whole build, not whichever
 * test finished last: an `unresolved` test keeps it `failure` however many
 * `passed` tests follow. `running` outranks `new` and `passed` so the commit
 * stays `pending` until every opened test has settled.
 */
const WORST_FIRST: readonly RunStatus[] = [
  "aborted",
  "failed",
  "unresolved",
  "empty",
  "running",
  "new",
  "passed",
];

/** The build-wide status from per-status test counts; null when it has no tests. */
export function aggregateBuildStatus(
  counts: RunStatusCounts,
): BuildStatusAggregate | null {
  let total = 0;
  for (const status of WORST_FIRST) total += counts[status] ?? 0;
  if (total === 0) return null;

  const status = WORST_FIRST.find((s) => (counts[s] ?? 0) > 0)!;
  const state = presentationFor(status).githubState;
  let inBucket = 0;
  for (const s of WORST_FIRST) {
    if (presentationFor(s).githubState === state) inBucket += counts[s] ?? 0;
  }
  return { status, total, inBucket };
}

/** GitHub rejects a commit-status description over this many characters. */
const MAX_DESCRIPTION_LENGTH = 140;

/**
 * The commit-status description for a build: the run-level wording for the
 * winning status, plus `(<inBucket> of <total> tests)` once there is more than
 * one test.
 */
export function describeBuildStatus(aggregate: BuildStatusAggregate): string {
  const base = presentationFor(aggregate.status).description;
  const text =
    aggregate.total > 1
      ? `${base} (${aggregate.inBucket} of ${aggregate.total} tests)`
      : base;
  return text.slice(0, MAX_DESCRIPTION_LENGTH);
}
