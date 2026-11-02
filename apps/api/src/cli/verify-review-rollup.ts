import { parseArgs } from "node:util";

import { getEnv } from "@furan/config";
import { createDb } from "@furan/db";

import { envSchema } from "../env.js";
import {
  countersMatch,
  findRollupMismatches,
  listBaselineRepairs,
  notRepairedLine,
  repairRunCounters,
  type RollupMismatch,
} from "../lib/review/rollup-verify.js";

/**
 * verify-review-rollup [--project <uuid>] [--repairs] [--repair-counters]
 *
 * Check after the review-model upgrade (spec §4.6, runbook
 * docs/runbooks/review-model-upgrade.md) and the server-reads upgrade (spec
 * 2026-10-27 §3.3). Recomputes `rollupRunStatus` for every finished run, and
 * the stored pending counters (`pending_steps` / `failed_steps`) for every
 * run, optionally of one project, and prints each run where either differs,
 * as `run_id, stored, computed, stored_counters, computed_counters` (counters
 * as `pending/failed`), then the count.
 * `--repairs` first lists the baselines migration 0036 repaired (its
 * `baseline.repair` audit rows). Without `--repair-counters` it never writes.
 *
 * `--repair-counters` then fixes the listed runs whose counters are wrong,
 * one at a time under each run's lock (`repairRunCounters`, through
 * `recomputeRunStatus`), so it is safe while the app runs. It never changes a
 * status: a run whose status is not its rollup is left for review-model-upgrade.md §5, and
 * printed with both (`<run_id>, not repaired: stored <status>, rollup
 * <status>`). The check then runs again and the exit code is its result.
 *
 * Exit codes: 0 no mismatches (left), 1 mismatches (or an error), 2 usage
 * error.
 */

const USAGE =
  "Usage: verify-review-rollup [--project <uuid>] [--repairs]" +
  " [--repair-counters]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usageError(message: string): number {
  console.error(message);
  console.error(USAGE);
  return 2;
}

const counters = (c: RollupMismatch["storedCounters"]): string =>
  `${c.pendingSteps}/${c.failedSteps}`;

/** Prints the mismatches, then their count. */
function report(mismatches: RollupMismatch[], suffix = ""): void {
  if (mismatches.length > 0) {
    console.log("run_id, stored, computed, stored_counters, computed_counters");
  }
  for (const m of mismatches) {
    console.log(
      [
        m.runId,
        m.stored,
        m.computed,
        counters(m.storedCounters),
        counters(m.computedCounters),
      ].join(", "),
    );
  }
  console.log(
    `${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}${suffix}`,
  );
}

async function main(): Promise<number> {
  let values: {
    project?: string;
    repairs?: boolean;
    "repair-counters"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        project: { type: "string" },
        repairs: { type: "boolean", default: false },
        "repair-counters": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return usageError((err as Error).message);
  }
  const projectId = values.project?.toLowerCase();
  if (projectId !== undefined && !UUID.test(projectId)) {
    return usageError(`--project must be a project id (uuid): ${projectId}`);
  }

  // Only the database is needed (fails closed if DATABASE_URL is missing).
  getEnv(envSchema.pick({ DATABASE_URL: true }));

  // The OWNER connection (`DATABASE_URL`), never the api's RLS-subject
  // `DATABASE_URL_APP`: under row-level security, with no request identity,
  // the policies hide every project-scoped row (`checkpoint_decisions`
  // included), so the check would read wrong inputs and report false
  // mismatches, or nothing at all, and the repair would recompute runs from
  // inputs it cannot see. The owner role bypasses RLS, so both see every
  // project. `createDb()` reads `DATABASE_URL`.
  const { db, close } = createDb();
  try {
    if (values.repairs) {
      const repairs = await listBaselineRepairs(db, { projectId });
      console.log(`baseline repairs (migration 0036): ${repairs.length}`);
      for (const r of repairs) {
        console.log(
          [
            r.id,
            r.createdAt.toISOString(),
            JSON.stringify({
              variationId: r.variationId,
              runId: r.runId,
              branch: r.branch,
              previousBaselineId: r.previousBaselineId,
              op: r.op,
            }),
          ].join(", "),
        );
      }
    }

    const mismatches = await findRollupMismatches(db, { projectId });
    report(mismatches);
    if (!values["repair-counters"]) return mismatches.length === 0 ? 0 : 1;

    const stale = mismatches.filter((m) => !countersMatch(m));
    const outcomes = await repairRunCounters(
      db,
      stale.map((m) => m.runId),
    );
    const repaired = outcomes.filter((o) => o.outcome === "repaired");
    console.log(
      `repaired the counters of ${repaired.length} run${repaired.length === 1 ? "" : "s"}`,
    );
    for (const o of outcomes) {
      const line = notRepairedLine(o);
      if (line !== null) console.log(line);
    }

    const left = await findRollupMismatches(db, { projectId });
    report(left, " after repair");
    return left.length === 0 ? 0 : 1;
  } finally {
    await close();
  }
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
