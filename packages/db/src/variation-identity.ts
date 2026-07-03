import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { testVariations } from "./schema/index.js";

/**
 * The branch-agnostic environment identity of a `test_variations` row — ADR-054's
 * full identity MINUS `projectId` + `branchName` (which are scoping, applied
 * separately). This is the single source of truth for "the same checkpoint
 * across branches": the sibling resolution in `resolveBaseline`'s cross-branch
 * tiers and the checkpoint-badge derivation (`deriveCheckpointStatuses`) both
 * match on it, and `resolveOrCreateVariation` upserts on the same columns plus
 * project + branch.
 *
 * If the ADR-054 identity gains a column, add it HERE (and to the
 * `test_variations_identity_unique` index + `resolveOrCreateVariation`'s
 * conflict target) — the two sibling-matchers pick it up automatically instead
 * of silently drifting onto a stale subset.
 */
export interface VariationIdentity {
  name: string;
  viewport: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
}

/**
 * Stable string key for IN-MEMORY identity matching. Field order is fixed and
 * must not change (it is only ever compared against itself within a process).
 * Scope by project separately — this key intentionally omits `projectId` so
 * callers compose it explicitly and cannot accidentally match across projects.
 */
export function variationIdentityKey(id: VariationIdentity): string {
  return JSON.stringify([id.name, id.viewport, id.browser, id.os, id.device]);
}

/**
 * Null-safe SQL matching the `test_variations` identity columns against `id`.
 * A nullable column (viewport/browser/os/device) matches with `IS NULL`, never
 * `= NULL`, mirroring the `NULLS NOT DISTINCT` unique. Compose with project +
 * branch scoping via `and(...)`.
 */
export function variationIdentityWhere(id: VariationIdentity): SQL {
  const nullable = (col: AnyPgColumn, val: string | null): SQL =>
    val === null ? isNull(col) : eq(col, val);
  // `and` is non-undefined given fixed non-empty args.
  return and(
    eq(testVariations.name, id.name),
    nullable(testVariations.viewport, id.viewport),
    nullable(testVariations.browser, id.browser),
    nullable(testVariations.os, id.os),
    nullable(testVariations.device, id.device),
  )!;
}
