import { parseArgs } from "node:util";

import { getEnv } from "@furan/config";
import { createDb } from "@furan/db";

import { envSchema } from "../env.js";
import {
  findRollupMismatches,
  listBaselineRepairs,
} from "../lib/review/rollup-verify.js";

/**
 * verify-review-rollup [--project <uuid>] [--repairs]
 *
 * Read-only check after the review-model upgrade (spec §4.6, runbook
 * docs/runbooks/review-model-upgrade.md). Recomputes `rollupRunStatus` for
 * every finished run (optionally of one project) and prints each run whose
 * stored status differs, as `run_id, stored, computed`, then the count.
 * `--repairs` first lists the baselines migration 0036 repaired (its
 * `baseline.repair` audit rows). Never writes.
 *
 * Exit codes: 0 no mismatches, 1 mismatches (or an error), 2 usage error.
 */

const USAGE = "Usage: verify-review-rollup [--project <uuid>] [--repairs]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usageError(message: string): number {
  console.error(message);
  console.error(USAGE);
  return 2;
}

async function main(): Promise<number> {
  let values: { project?: string; repairs?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        project: { type: "string" },
        repairs: { type: "boolean", default: false },
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

  getEnv(envSchema); // fails closed if env malformed

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
    if (mismatches.length > 0) console.log("run_id, stored, computed");
    for (const m of mismatches) {
      console.log(`${m.runId}, ${m.stored}, ${m.computed}`);
    }
    console.log(
      `${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`,
    );
    return mismatches.length === 0 ? 0 : 1;
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
