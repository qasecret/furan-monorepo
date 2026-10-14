import {
  and,
  baselines,
  baselineWriteTime,
  eq,
  sql,
  testVariations,
  type Tx,
} from "@furan/db";
import type { DecisionSnapshot } from "@furan/shared-types";

/**
 * Marks a variation ignore region that approve promoted from a checkpoint's
 * SDK-captured regions (ADR-067). Everything without it is reviewer-owned
 * (setIgnoreAreas / addIgnoreAreas / an approve override). The worker's region
 * parse strips the key, so it never affects masking.
 */
export const SDK_REGION_SOURCE = "sdk";

const isSdkRegion = (r: unknown): boolean =>
  typeof r === "object" &&
  r !== null &&
  (r as { source?: unknown }).source === SDK_REGION_SOURCE;

/** Geometry + viewport — the same dedupe key the diff-worker uses. */
const regionKey = (r: object): string => {
  const { x, y, width, height, viewport } = r as Record<string, unknown>;
  return `${String(x)}:${String(y)}:${String(width)}:${String(height)}:${
    typeof viewport === "string" ? viewport : ""
  }`;
};

/**
 * A variation's ignore regions after an approve that carries no reviewer
 * override (ADR-067): reviewer-owned regions are kept as-is, and the SDK set an
 * earlier approve promoted is REPLACED by this checkpoint's captured regions
 * (tagged so the next approve can replace them in turn). Replacing rather than
 * appending keeps capture-time boxes that move between runs (the SDK's
 * caret-focus region) from piling up. A captured region whose geometry matches
 * a kept one is dropped, so a reviewer's edit of it wins. Empty → null.
 */
export function mergeApprovedIgnoreRegions(
  existing: unknown,
  captured: unknown,
): unknown[] | null {
  const kept = (Array.isArray(existing) ? existing : []).filter(
    (r) => !isSdkRegion(r),
  );
  const seen = new Set(
    kept.filter((r) => typeof r === "object" && r !== null).map(regionKey),
  );
  const out = [...kept];
  for (const r of Array.isArray(captured) ? captured : []) {
    if (typeof r !== "object" || r === null) continue;
    const key = regionKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, source: SDK_REGION_SOURCE });
  }
  return out.length > 0 ? out : null;
}

/** The screenshot fields a promotion writes onto the variation and baseline. */
export interface ApprovableCheckpoint {
  testVariationId: string;
  imageKey: string | null;
  ignoreRegions: unknown;
  layoutRegions: unknown;
  floatingRegions: unknown;
  contentRegions: unknown;
  accessibilityRegions: unknown;
  matchLevel: string;
}
export interface ApprovableRun {
  id: string;
  name: string | null;
  branchName: string | null;
}

/**
 * A timestamptz as an ISO-8601 UTC string with microseconds. A JS `Date` would
 * truncate to milliseconds, and `created_at` orders baselines at microsecond
 * resolution (ADR-068), so an undo must be able to put back the exact value.
 */
const isoMicros = (
  col: typeof baselines.createdAt | typeof baselines.updatedAt,
) =>
  sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Promotes one checkpoint to its variation's baseline inside an existing
 * transaction, and returns what the promotion replaced (the undo snapshot,
 * spec §4.2). It never writes the run's status: that is `recomputeRunStatus`'s
 * job (spec §4.3).
 *
 * 1. Locks the variation row and any existing (variation, run) `baselines`
 *    row `FOR NO KEY UPDATE` (R8: only non-key columns are written, and FK
 *    inserts of child rows take `FOR KEY SHARE`), and snapshots both before
 *    anything is written.
 * 2. Writes the checkpoint's image, regions and match level onto the
 *    variation. Without an override the ignore regions are merged
 *    (`mergeApprovedIgnoreRegions`, ADR-067); `ignoreAreasOverride` (ADR-036)
 *    replaces them.
 * 3. Upserts the (variation, run) baseline row, stamped with
 *    `baselineWriteTime()` so the checkpoint written last is current (ADR-068).
 *
 * The snapshot also records the variation fields as written
 * (`variationAfter`), so an undo can tell a later edit from its own write.
 *
 * The snapshot's region keys are always present (`undefined` → `null`):
 * `JSON.stringify` drops undefined keys, which would leave an unparseable
 * snapshot behind.
 */
export async function promoteCheckpointInTx(
  tx: Tx,
  s: ApprovableCheckpoint & { id: string },
  run: ApprovableRun,
  userId: string,
  ignoreAreasOverride?: readonly unknown[] | null,
): Promise<DecisionSnapshot> {
  const [v] = await tx
    .select({
      id: testVariations.id,
      baselineName: testVariations.baselineName,
      matchLevel: testVariations.matchLevel,
      ignoreRegions: testVariations.ignoreRegions,
      layoutRegions: testVariations.layoutRegions,
      floatingRegions: testVariations.floatingRegions,
      contentRegions: testVariations.contentRegions,
      accessibilityRegions: testVariations.accessibilityRegions,
    })
    .from(testVariations)
    .where(eq(testVariations.id, s.testVariationId))
    .for("no key update");
  if (!v) {
    throw new Error(
      `variation_not_found:${s.testVariationId} (checkpoint ${s.id})`,
    );
  }
  const [prev] = await tx
    .select({
      id: baselines.id,
      baselineName: baselines.baselineName,
      userId: baselines.userId,
      branchName: baselines.branchName,
      createdAt: isoMicros(baselines.createdAt),
      updatedAt: isoMicros(baselines.updatedAt),
    })
    .from(baselines)
    .where(
      and(
        eq(baselines.testVariationId, s.testVariationId),
        eq(baselines.testRunId, run.id),
      ),
    )
    .for("no key update");

  const variation: NonNullable<DecisionSnapshot["variation"]> = {
    id: v.id,
    baselineName: v.baselineName,
    matchLevel: v.matchLevel,
    ignoreRegions: v.ignoreRegions ?? null,
    layoutRegions: v.layoutRegions ?? null,
    floatingRegions: v.floatingRegions ?? null,
    contentRegions: v.contentRegions ?? null,
    accessibilityRegions: v.accessibilityRegions ?? null,
  };

  const ignoreRegions =
    ignoreAreasOverride === undefined
      ? mergeApprovedIgnoreRegions(v.ignoreRegions, s.ignoreRegions)
      : ignoreAreasOverride;
  // RETURNING gives exactly what was stored (jsonb as Postgres normalised it),
  // which an undo compares against to spot a later edit (R25).
  const [after] = await tx
    .update(testVariations)
    .set({
      baselineName: s.imageKey,
      ignoreRegions,
      layoutRegions: s.layoutRegions,
      floatingRegions: s.floatingRegions,
      contentRegions: s.contentRegions,
      accessibilityRegions: s.accessibilityRegions,
      matchLevel: s.matchLevel,
      updatedAt: new Date(),
    })
    .where(eq(testVariations.id, s.testVariationId))
    .returning({
      baselineName: testVariations.baselineName,
      matchLevel: testVariations.matchLevel,
      ignoreRegions: testVariations.ignoreRegions,
      layoutRegions: testVariations.layoutRegions,
      floatingRegions: testVariations.floatingRegions,
      contentRegions: testVariations.contentRegions,
      accessibilityRegions: testVariations.accessibilityRegions,
    });
  if (!after) {
    throw new Error(
      `variation_not_found:${s.testVariationId} (checkpoint ${s.id})`,
    );
  }
  const variationAfter: NonNullable<DecisionSnapshot["variationAfter"]> = {
    baselineName: after.baselineName,
    matchLevel: after.matchLevel,
    ignoreRegions: after.ignoreRegions ?? null,
    layoutRegions: after.layoutRegions ?? null,
    floatingRegions: after.floatingRegions ?? null,
    contentRegions: after.contentRegions ?? null,
    accessibilityRegions: after.accessibilityRegions ?? null,
  };

  // Upsert on (variation, run) so re-approving a checkpoint doesn't violate the
  // baselines_variation_run_unique constraint / append a duplicate row. Both
  // branches stamp baselineWriteTime so the checkpoint approved last wins.
  const [written] = await tx
    .insert(baselines)
    .values({
      baselineName: s.imageKey ?? run.name ?? "auto",
      testVariationId: s.testVariationId,
      testRunId: run.id,
      userId,
      ...(run.branchName ? { branchName: run.branchName } : {}),
      createdAt: baselineWriteTime(),
    })
    .onConflictDoUpdate({
      target: [baselines.testVariationId, baselines.testRunId],
      set: {
        baselineName: s.imageKey ?? run.name ?? "auto",
        userId,
        ...(run.branchName ? { branchName: run.branchName } : {}),
        createdAt: baselineWriteTime(),
        updatedAt: new Date(),
      },
    })
    .returning({
      id: baselines.id,
      // xmax = 0 only on a freshly inserted row version.
      inserted: sql<boolean>`(xmax = 0)`,
    });
  // The variation lock does not stop another writer's FK insert, so a
  // (variation, run) row that appeared after the read would make "inserted"
  // a lie, and its undo would delete that writer's row. Refuse instead.
  if (!written || (!prev && !written.inserted)) {
    throw new Error(
      `baseline_write_raced:${s.testVariationId}:${run.id} (checkpoint ${s.id})`,
    );
  }

  return {
    baseline: prev
      ? {
          op: "updated",
          id: prev.id,
          prev: {
            baselineName: prev.baselineName,
            userId: prev.userId,
            branchName: prev.branchName,
            createdAt: prev.createdAt,
            updatedAt: prev.updatedAt,
          },
        }
      : { op: "inserted", id: written.id },
    variation,
    variationAfter,
  };
}
