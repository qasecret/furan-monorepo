#!/usr/bin/env node
/**
 * One-shot storage-orphan reconcile CLI (issue #346). Deletes storage objects
 * that no DB row references and that are older than a safety window (so an
 * in-flight upload mid-commit is never swept). Runs as the owner DB role
 * (bypasses RLS), so it sees every project's rows.
 *
 * Usage:
 *   pnpm --filter @furan/diff-worker exec tsx src/cli/reconcile-storage.ts
 *   pnpm --filter @furan/diff-worker exec tsx src/cli/reconcile-storage.ts --dry-run
 *   pnpm --filter @furan/diff-worker exec tsx src/cli/reconcile-storage.ts --older-than-hours 72
 */
import { parseArgs } from "node:util";

import { createDb } from "@furan/db";
import { createStorage } from "@furan/storage";

import {
  gatherReferencedKeys,
  reconcileOrphans,
} from "../orphan-reconcile.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "older-than-hours": { type: "string", default: "24" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const olderThanHours = Number(values["older-than-hours"]);
  if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
    throw new Error("--older-than-hours must be a non-negative number");
  }
  const dryRun = Boolean(values["dry-run"]);

  const { db, close } = createDb();
  const storage = createStorage();
  try {
    const referenced = await gatherReferencedKeys(db);
    const result = await reconcileOrphans(storage, referenced, {
      olderThanHours,
      dryRun,
    });
    console.log(
      JSON.stringify(
        {
          scanned: result.scanned,
          referenced: referenced.size,
          deleted: result.deleted,
          olderThanHours,
          dryRun,
          deletedKeys: result.deletedKeys,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
