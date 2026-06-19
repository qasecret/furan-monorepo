import { createHash } from "node:crypto";

import type { DiffRegion } from "./types.js";

/**
 * Region sources excluded from the signature. Image-first (ADR-047): image
 * (l1_pixel) regions are the PRIMARY "what changed" signal and now drive the
 * signature; only synthetic dynamic-text OCR audit rows are excluded (they're
 * audit-only and hidden from the diff list/stepper). KEEP IN SYNC with the
 * dashboard's `orderDiffRegions` filter (apps/dashboard/.../diff-order.ts),
 * which likewise excludes only dynamic_text. (Not a shared import: the
 * dashboard has its own region types and must not depend on this node-only
 * package.)
 */
export const EXCLUDED_SOURCES = new Set<string>(["dynamic_text"]);

/** Normalize a pixel coordinate to a 0..100 integer bucket of `dim` (>0). */
function bucket(value: number, dim: number): number {
  return Math.round((value / dim) * 100);
}

/**
 * Stable element anchor pinning the region's identity, or `null` when it pins
 * no element. For axe regions, pins the first selector in `axeTarget`.
 * L1/l1_pixel regions carry no element anchor and return `null`.
 */
function anchorOf(r: DiffRegion): string | null {
  if (r.axeTarget !== undefined && r.axeTarget.length > 0) {
    return `axe:${r.axeTarget[0]}`;
  }
  return null;
}

/**
 * Stable per-checkpoint diff signature (ADR-042). Two checkpoints with the
 * same meaningful change set produce the same signature regardless of region
 * order. Returns `null` (→ "ungrouped") when there are no meaningful regions,
 * OR when the checkpoint's image dimensions are unknown/non-positive: without
 * valid dimensions every normalized bbox would collapse to 0 and falsely group
 * unrelated checkpoints, so we decline to fingerprint instead.
 *
 * Excludes only dynamic_text and the volatile `description` (image-first,
 * ADR-047 — l1_pixel regions now drive the signature); bbox is normalized +
 * bucketed to a 1% grid; `axeTarget` pins element identity for axe regions.
 * The `v1:` prefix lets a future algorithm ship as `v2:`.
 */
export function computeCheckpointSignature(
  regions: DiffRegion[],
  imageSize: { width: number; height: number },
): string | null {
  if (
    !Number.isFinite(imageSize.width) ||
    imageSize.width <= 0 ||
    !Number.isFinite(imageSize.height) ||
    imageSize.height <= 0
  ) {
    return null;
  }

  // One canonical key per meaningful region. Fields go into a JSON array (so a
  // delimiter inside an anchor can't collide with a real separator) which is
  // serialized exactly once here; sorting the keys makes the signature
  // order-independent without re-serializing per comparison.
  const keys = regions
    .filter((r) => !EXCLUDED_SOURCES.has(r.source))
    .map((r) =>
      JSON.stringify([
        r.category,
        r.severity,
        r.source,
        bucket(r.bbox.x, imageSize.width),
        bucket(r.bbox.y, imageSize.height),
        bucket(r.bbox.width, imageSize.width),
        bucket(r.bbox.height, imageSize.height),
        anchorOf(r),
      ]),
    );

  if (keys.length === 0) return null;

  keys.sort();

  const hash = createHash("sha256").update(keys.join("\n")).digest("hex");
  return `v1:${hash}`;
}
