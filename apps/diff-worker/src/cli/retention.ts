#!/usr/bin/env node
/**
 * One-shot retention-sweep CLI (Phase 5 D3). Enqueues a `retention` job
 * onto the BullMQ queue that the diff-worker already drains. Useful for
 * out-of-cycle sweeps (e.g., after a project's `retentionDays` is
 * lowered) or for dry-running the planned deletion before the next
 * nightly cron fires.
 *
 * Usage:
 *   pnpm --filter @furan/diff-worker cli:retention
 *   pnpm --filter @furan/diff-worker cli:retention -- --dry-run
 *   pnpm --filter @furan/diff-worker cli:retention -- \
 *       --project-id <uuid> --project-id <uuid> --dry-run
 */
import { parseArgs } from "node:util";

import { createRetentionQueue } from "@furan/queue";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "project-id": { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const projectIds = (values["project-id"] as string[] | undefined) ?? [];
  const dryRun = Boolean(values["dry-run"]);

  const queue = createRetentionQueue();
  const job = await queue.add("retention-cli", {
    ...(projectIds.length > 0 ? { projectIds } : {}),
    dryRun,
  });
  console.log(
    JSON.stringify(
      {
        enqueued: true,
        jobId: job.id,
        projectIds: projectIds.length > 0 ? projectIds : "all-eligible",
        dryRun,
      },
      null,
      2,
    ),
  );
  await queue.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
