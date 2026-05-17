import {
  and,
  eq,
  gt,
  inArray,
  lt,
  projects,
  screenshots,
  testRuns,
  withProjectScope,
  type DB,
} from "@furan/db";
import type { RetentionJob } from "@furan/queue";
import type { Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import { Counter, Histogram, type Registry } from "prom-client";

type Logger = Telemetry["logger"];

/** Conservative TTL for the per-project Redis lock; the nightly job at
 *  3am UTC typically finishes in seconds, but slow MinIO sweeps on a
 *  long-retained project could push it. 1h is the spec default. */
const LOCK_TTL_SECONDS = 3600;

/** Batch size for the orphan-sweep recheck query. Keep below the
 *  Postgres parameter cap (~32k) and well below the ioredis pipeline
 *  ceiling. 1000 image_keys per round-trip is comfortably under both. */
const ORPHAN_SWEEP_BATCH = 1000;

export interface RetentionMetrics {
  deletedRuns: Counter<"project_id">;
  freedBytes: Counter<"project_id">;
  orphanSweepDuration: Histogram<"project_id">;
  lockSkipped: Counter<"project_id">;
}

/**
 * Factory for the four retention metrics. Mirrors the
 * `createDlqCounter(registry)` pattern in
 * `apps/integrations/src/webhooks/delivery.ts` — the server bootstrap
 * passes the telemetry registry in once at startup.
 */
export function createRetentionMetrics(registry: Registry): RetentionMetrics {
  return {
    deletedRuns: new Counter({
      name: "furan_retention_deleted_runs_total",
      help: "Test runs deleted by the nightly retention TTL job",
      labelNames: ["project_id"],
      registers: [registry],
    }),
    freedBytes: new Counter({
      name: "furan_retention_freed_bytes_total",
      help: "Object-storage bytes freed by the retention orphan sweep",
      labelNames: ["project_id"],
      registers: [registry],
    }),
    orphanSweepDuration: new Histogram({
      name: "furan_retention_orphan_sweep_duration_seconds",
      help: "Wall-clock duration of the orphan-sweep phase per project",
      labelNames: ["project_id"],
      buckets: [0.1, 1, 10, 60, 300],
      registers: [registry],
    }),
    lockSkipped: new Counter({
      name: "furan_retention_lock_skipped_total",
      help: "Retention sweeps skipped because the per-project lock was held",
      labelNames: ["project_id"],
      registers: [registry],
    }),
  };
}

export interface RetentionHandlerDeps {
  db: DB;
  redis: Redis;
  storage: Storage;
  metrics: RetentionMetrics;
}

/**
 * Per-project TTL sweep (Phase 5 D3 / spec §9 GA-row metric
 * "`projects.retention_days` enforced nightly"). For each project where
 * `retentionDays > 0`:
 *   1. Take a Redis NX lock (`retention-lock:<projectId>`, 1h TTL) so the
 *      nightly cron and an ad-hoc CLI run can't race.
 *   2. Compute cutoff = now - retentionDays * 24h.
 *   3. Capture the image_keys referenced by the to-be-deleted runs'
 *      screenshots BEFORE deletion (cascade nukes the rows, so we'd lose
 *      the keys otherwise).
 *   4. DELETE expired test_runs — FK cascade auto-cleans diff_regions +
 *      screenshots.
 *   5. Orphan-sweep: re-query screenshots for any surviving rows that
 *      still reference each captured image_key; delete the unreferenced
 *      ones from object storage in 1000-key batches.
 *
 * dryRun=true short-circuits AFTER computing the would-delete count
 * (logged via `retention_dry_run`) without touching DB or storage.
 *
 * Note on the orphan sweep: today `screenshots.image_key` has a global
 * UNIQUE index, so any captured key whose screenshot row was cascade-
 * deleted is necessarily an orphan — the `inArray` recheck below will
 * always return zero matches. The recheck is preserved anyway as
 * defense-in-depth in case the uniqueness constraint is ever relaxed
 * (e.g., if storage gets per-project namespacing).
 */
export async function handleRetentionJob(
  data: RetentionJob,
  logger: Logger,
  deps: RetentionHandlerDeps,
): Promise<void> {
  const projectRows = data.projectIds?.length
    ? await deps.db
        .select()
        .from(projects)
        .where(inArray(projects.id, data.projectIds))
    : await deps.db
        .select()
        .from(projects)
        .where(gt(projects.retentionDays, 0));

  for (const project of projectRows) {
    if ((project.retentionDays ?? 0) <= 0) {
      // Double-check guard for the explicit-projectIds path; the
      // implicit-sweep path already filtered via gt(retentionDays, 0).
      logger.info(
        { projectId: project.id, retentionDays: project.retentionDays },
        "retention_skip_disabled",
      );
      continue;
    }

    const lockKey = `retention-lock:${project.id}`;
    const acquired = await deps.redis.set(
      lockKey,
      "1",
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );
    if (acquired === null) {
      logger.info({ projectId: project.id }, "retention_lock_held_skip");
      deps.metrics.lockSkipped.inc({ project_id: project.id });
      continue;
    }

    try {
      const cutoffMs = Date.now() - project.retentionDays * 24 * 60 * 60 * 1000;
      const cutoff = new Date(cutoffMs);

      const oldRuns = await deps.db
        .select({ id: testRuns.id })
        .from(testRuns)
        .where(
          and(
            eq(testRuns.projectId, project.id),
            lt(testRuns.createdAt, cutoff),
          ),
        );
      const ids = oldRuns.map((r) => r.id);

      if (data.dryRun) {
        logger.info(
          {
            projectId: project.id,
            wouldDelete: ids.length,
            retentionDays: project.retentionDays,
            cutoff: cutoff.toISOString(),
          },
          "retention_dry_run",
        );
        continue;
      }

      if (ids.length === 0) {
        logger.info(
          { projectId: project.id, retentionDays: project.retentionDays },
          "retention_nothing_to_delete",
        );
        continue;
      }

      // Capture image_keys BEFORE cascade-delete so we can identify
      // candidate orphans afterward. Without this step, the cascade
      // would erase the screenshots rows and the keys with them.
      const screenshotKeys = await deps.db
        .select({ key: screenshots.imageKey })
        .from(screenshots)
        .where(inArray(screenshots.runId, ids));
      const candidateKeys = [...new Set(screenshotKeys.map((r) => r.key))];

      await withProjectScope(deps.db, project.id, async (tx) => {
        await tx.delete(testRuns).where(inArray(testRuns.id, ids));
        // FK cascade auto-deletes screenshots + diff_regions.
      });
      deps.metrics.deletedRuns.inc({ project_id: project.id }, ids.length);

      // Orphan sweep: any candidateKey not referenced by a surviving
      // screenshots row is unambiguously orphaned and can be deleted
      // from object storage. Process in batches to keep the IN-list
      // bounded.
      const sweepStart = Date.now();
      let totalFreed = 0;
      for (let i = 0; i < candidateKeys.length; i += ORPHAN_SWEEP_BATCH) {
        const batch = candidateKeys.slice(i, i + ORPHAN_SWEEP_BATCH);
        const stillReferenced = new Set(
          (
            await deps.db
              .select({ key: screenshots.imageKey })
              .from(screenshots)
              .where(inArray(screenshots.imageKey, batch))
          ).map((r) => r.key),
        );
        const orphans = batch.filter((k) => !stillReferenced.has(k));
        for (const key of orphans) {
          try {
            const head = await deps.storage.head(key);
            await deps.storage.delete(key);
            totalFreed += head?.size ?? 0;
          } catch (err) {
            // Best-effort: a missing object (e.g., already swept by a
            // previous run that crashed between DB commit and storage
            // delete) shouldn't bail the whole sweep.
            logger.warn(
              { err, key, projectId: project.id },
              "retention_orphan_delete_failed",
            );
          }
        }
      }
      const sweepSeconds = (Date.now() - sweepStart) / 1000;
      deps.metrics.freedBytes.inc({ project_id: project.id }, totalFreed);
      deps.metrics.orphanSweepDuration.observe(
        { project_id: project.id },
        sweepSeconds,
      );
      logger.info(
        {
          projectId: project.id,
          deletedRuns: ids.length,
          freedBytes: totalFreed,
          orphanCandidates: candidateKeys.length,
          sweepSeconds,
        },
        "retention_completed",
      );
    } finally {
      // Release the lock — best-effort; if the worker died mid-run the
      // 1h TTL eventually frees it.
      try {
        await deps.redis.del(lockKey);
      } catch (err) {
        logger.warn(
          { err, projectId: project.id },
          "retention_lock_release_failed",
        );
      }
    }
  }
}
