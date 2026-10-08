import { type DB, screenshots, testRuns } from "@furan/db";
import type { Storage } from "@furan/storage";

/**
 * Storage-orphan reconcile (issue #346). A screenshot upload writes its S3
 * objects BEFORE the DB row commits (`persistScreenshot`), so a rolled-back /
 * failed upload leaves objects no row references. Retention keys off DB rows, so
 * those orphans are never reclaimed. This sweep lists the bucket, drops objects
 * with no referencing key that are older than a safety window (so an in-flight
 * upload mid-commit is never deleted).
 */
export interface OrphanReconcileResult {
  scanned: number;
  deleted: number;
  deletedKeys: string[];
}

/**
 * Every storage key a DB row currently references:
 * `screenshots.{image,dom,element_map}_key` + `test_runs.{image,diff}_name`.
 * Mirror this if a new key-bearing column/table is added (same list the
 * storage-proxy guards). Runs as the owner (workers bypass RLS) so it sees all
 * projects.
 */
export async function gatherReferencedKeys(db: DB): Promise<Set<string>> {
  const referenced = new Set<string>();
  const shots = await db
    .select({
      imageKey: screenshots.imageKey,
      domKey: screenshots.domKey,
      elementMapKey: screenshots.elementMapKey,
    })
    .from(screenshots);
  for (const r of shots) {
    for (const k of [r.imageKey, r.domKey, r.elementMapKey]) {
      if (k) referenced.add(k);
    }
  }
  const runs = await db
    .select({ imageName: testRuns.imageName, diffName: testRuns.diffName })
    .from(testRuns);
  for (const r of runs) {
    for (const k of [r.imageName, r.diffName]) {
      if (k) referenced.add(k);
    }
  }
  return referenced;
}

/**
 * Delete storage objects that (a) no DB row references and (b) are older than
 * `olderThanHours` — the age guard is the safety net for the upload's
 * write-object-then-commit-row window, so a just-uploaded object mid-commit is
 * never swept. Pure given `referenced` + `storage`, so it's unit-testable
 * without a DB (the CLI wires in {@link gatherReferencedKeys}).
 */
export async function reconcileOrphans(
  storage: Storage,
  referenced: Set<string>,
  opts: { olderThanHours: number; now?: Date; dryRun?: boolean },
): Promise<OrphanReconcileResult> {
  const objects = await storage.list();
  const cutoffMs =
    (opts.now ?? new Date()).getTime() - opts.olderThanHours * 3_600_000;
  const deletedKeys: string[] = [];
  for (const o of objects) {
    if (referenced.has(o.key)) continue;
    if (o.lastModified.getTime() >= cutoffMs) continue; // too recent — maybe in-flight
    if (!opts.dryRun) await storage.delete(o.key);
    deletedKeys.push(o.key);
  }
  return { scanned: objects.length, deleted: deletedKeys.length, deletedKeys };
}
