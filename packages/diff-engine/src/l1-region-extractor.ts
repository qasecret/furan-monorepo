import { PNG } from "pngjs";

import type { DiffRegion } from "./types.js";

/**
 * Cluster differing pixels between baseline + candidate into bounded
 * rectangular regions, so the dashboard's Regions panel + diff-heatmap
 * overlay can show "what changed" even when the L1 backend (odiff,
 * pixelmatch, looks-same) emits no regions of its own. Engine-agnostic
 * — runs independently after L1 by re-decoding the buffers.
 *
 * Algorithm: tile the image into `tileSize`×`tileSize` cells, count
 * differing pixels per tile (with a per-channel tolerance for JPEG/anti-
 * aliasing noise), then merge horizontally + vertically adjacent dirty
 * tiles into bounding rectangles via a flood-fill on the tile grid.
 *
 * Pixel-level connected-components would give tighter boxes but at
 * order-of-magnitude higher cost; tile clustering hits ~150ms on a
 * 2560×1266 image vs ~1.5s for per-pixel CC, and reviewers don't need
 * sub-32px precision when they're scanning a diff heatmap.
 */
export interface ExtractOptions {
  /** Square tile size in image pixels. Smaller = tighter boxes, more work. */
  tileSize?: number;
  /** Minimum fraction of pixels in a tile that must differ for it to be
   *  marked dirty. Filters out single-pixel speckle from JPEG noise. */
  minTileDiffRatio?: number;
  /** Per-channel absolute tolerance (0..255). Mirrors odiff's antialias
   *  ignore by treating tiny per-channel deltas as a match. */
  channelTolerance?: number;
  /** Drop merged clusters smaller than this many tiles. Keeps the panel
   *  signal-to-noise high when only a handful of speckles remain. */
  minClusterTiles?: number;
}

const DEFAULTS: Required<ExtractOptions> = {
  // 48×48 tile (2304 px). Bigger than 32 dilutes anti-aliasing + sub-
  // pixel font noise enough that flood-fill stops bridging unrelated
  // diffs into one whole-image blob. Reviewer affordance is unchanged
  // (~96 px minimum cluster footprint via `minClusterTiles=3` below).
  tileSize: 48,
  // 0.22 = 507 of 2304 px in a tile must differ before it's flagged.
  // Picks up real visible changes; rejects font kerning shifts +
  // JPEG block artifacts that historically dominated the false-
  // positive bucket on web content.
  minTileDiffRatio: 0.22,
  // Per-channel absolute tolerance (0..255). Sub-pixel font rendering
  // and JPEG block noise produce 10-14/255 drift on solid backgrounds;
  // 16 is well below the smallest perceptually-meaningful delta.
  channelTolerance: 16,
  // 3 tiles ≈ 144 px linear / ~96×96 footprint — the smallest blob a
  // reviewer scanning a heatmap will actually fixate on. Pairs with
  // the larger tileSize: same absolute floor as 4×32 tiles.
  minClusterTiles: 3,
};

export function extractL1PixelRegions(
  baselineBytes: Buffer,
  candidateBytes: Buffer,
  options: ExtractOptions = {},
): DiffRegion[] {
  const opts = { ...DEFAULTS, ...options };

  let baseline: PNG;
  let candidate: PNG;
  try {
    baseline = PNG.sync.read(baselineBytes);
    candidate = PNG.sync.read(candidateBytes);
  } catch {
    // Malformed image → no regions, let L1's own dimension/decode path
    // surface the error.
    return [];
  }
  // Dimension mismatch is a layout regression on its own; the engine's
  // L1 backends report it. Skip here rather than risk an out-of-bounds
  // read against the smaller buffer.
  if (
    baseline.width !== candidate.width ||
    baseline.height !== candidate.height
  ) {
    return [];
  }

  const { width: W, height: H } = baseline;
  const tile = opts.tileSize;
  const cols = Math.ceil(W / tile);
  const rows = Math.ceil(H / tile);
  const dirty = new Uint8Array(cols * rows);

  // Count diff pixels per tile in one pass.
  const tileCounts = new Uint32Array(cols * rows);
  const b = baseline.data;
  const c = candidate.data;
  const tol = opts.channelTolerance;
  // RGBA pixels in pngjs `data`. Iterate row-major; locality helps the
  // CPU cache and the inner branch is predictable on long runs.
  for (let y = 0; y < H; y++) {
    const tileRow = (y / tile) | 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const bR = b[i] ?? 0;
      const bG = b[i + 1] ?? 0;
      const bB = b[i + 2] ?? 0;
      const cR = c[i] ?? 0;
      const cG = c[i + 1] ?? 0;
      const cB = c[i + 2] ?? 0;
      if (
        Math.abs(bR - cR) > tol ||
        Math.abs(bG - cG) > tol ||
        Math.abs(bB - cB) > tol
      ) {
        const tileCol = (x / tile) | 0;
        const tIdx = tileRow * cols + tileCol;
        tileCounts[tIdx] = (tileCounts[tIdx] ?? 0) + 1;
      }
    }
  }

  const minPixelsPerTile = opts.minTileDiffRatio * tile * tile;
  for (let i = 0; i < dirty.length; i++) {
    if ((tileCounts[i] ?? 0) >= minPixelsPerTile) dirty[i] = 1;
  }

  // Flood-fill 4-connected tile components.
  const visited = new Uint8Array(cols * rows);
  const regions: DiffRegion[] = [];
  const stack: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const start = r * cols + cIdx;
      if (!dirty[start] || visited[start]) continue;
      let minR = r,
        maxR = r,
        minC = cIdx,
        maxC = cIdx,
        size = 0;
      stack.push(start);
      visited[start] = 1;
      while (stack.length > 0) {
        const idx = stack.pop();
        if (idx === undefined) break;
        const cr = (idx / cols) | 0;
        const cc = idx - cr * cols;
        size++;
        if (cr < minR) minR = cr;
        if (cr > maxR) maxR = cr;
        if (cc < minC) minC = cc;
        if (cc > maxC) maxC = cc;
        const neighbors = [
          cr > 0 ? idx - cols : -1,
          cr < rows - 1 ? idx + cols : -1,
          cc > 0 ? idx - 1 : -1,
          cc < cols - 1 ? idx + 1 : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && dirty[n] && !visited[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        }
      }
      if (size < opts.minClusterTiles) continue;

      const x = minC * tile;
      const y = minR * tile;
      const width = Math.min((maxC + 1) * tile, W) - x;
      const height = Math.min((maxR + 1) * tile, H) - y;
      regions.push({
        id: `l1-pixel-${regions.length}`,
        severity: "minor",
        category: "image",
        bbox: { x, y, width, height },
        description: `Pixel diff cluster (${size} tiles, ${width}×${height})`,
        // Distinct from "l1" so the dashboard's Regions panel can suppress
        // these (they're noisy by design and visualised on the canvas
        // as yellow rectangles, not as scrollable rows). See engine.ts
        // wiring + RegionListPanel filter.
        source: "l1_pixel",
      });
    }
  }

  return regions;
}
