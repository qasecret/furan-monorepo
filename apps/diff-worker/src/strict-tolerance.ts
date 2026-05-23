import type { BBox } from "./bbox.js";

/**
 * Raw-decoded diff image. Produced by `sharp(bytes).raw().toBuffer({
 * resolveWithObject: true })`. `data` is RGBA, 4 bytes per pixel,
 * row-major. Both pixelmatch and odiff write opaque (alpha=255) pixels
 * for diffs and transparent (alpha=0) for matches.
 */
export interface DiffRaw {
  data: Buffer;
  info: { width: number; height: number };
}

export interface StrictRegionInput {
  /** Region bbox after selector/padding resolution (= worker's `resolvedIgnoreAreas` entry). */
  resolved: BBox;
  /** 0..1 fraction; `undefined` means "no tolerance" → any mismatch fails. */
  thresholdOverride?: number;
}

export interface StrictBreach {
  bbox: BBox;
  fraction: number;
  threshold: number;
  source: "strict";
}

/**
 * Count opaque pixels inside a bbox + return the bbox's total pixel
 * count (clamped to image bounds). Used by `strictBreaches` to compute
 * the breach fraction, and exported for unit-testability.
 *
 * Sub-millisecond at typical sizes — see design doc §1.
 */
export function countDiffPixelsInBbox(
  img: DiffRaw,
  bbox: BBox,
): { diffCount: number; totalPixels: number } {
  const { data, info } = img;
  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(info.width, Math.ceil(bbox.x + bbox.width));
  const y1 = Math.min(info.height, Math.ceil(bbox.y + bbox.height));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  if (w === 0 || h === 0) return { diffCount: 0, totalPixels: 0 };

  let diffCount = 0;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * info.width;
    for (let x = x0; x < x1; x++) {
      // pixelmatch + odiff write opaque diff pixels; transparent = match.
      if (data[(rowOffset + x) * 4 + 3]! > 0) diffCount++;
    }
  }
  return { diffCount, totalPixels: w * h };
}

/**
 * For each strict region, compute the diff fraction inside its bbox and
 * compare against `thresholdOverride`. Return one `StrictBreach` per
 * region whose fraction exceeds the threshold. The handler turns these
 * into `severity: "breaking"` diff regions and forces `passed: false`.
 *
 * Inclusive pass: a fraction exactly equal to the threshold is NOT a
 * breach. Matches reviewer intuition — "tolerance 0.5%" means "up to
 * and including 0.5% diff is acceptable."
 *
 * Regions whose bbox lies fully outside the image are skipped (no
 * meaningful comparison possible).
 */
export function strictBreaches(
  strictRegions: StrictRegionInput[],
  diffImg: DiffRaw,
): StrictBreach[] {
  const out: StrictBreach[] = [];
  for (const r of strictRegions) {
    const tol = r.thresholdOverride ?? 0;
    const stats = countDiffPixelsInBbox(diffImg, r.resolved);
    if (stats.totalPixels === 0) continue;
    const fraction = stats.diffCount / stats.totalPixels;
    if (fraction > tol) {
      out.push({
        bbox: r.resolved,
        fraction,
        threshold: tol,
        source: "strict",
      });
    }
  }
  return out;
}
