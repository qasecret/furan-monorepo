import { PNG } from "pngjs";

import type { IgnoreArea } from "./masking.js";
import type { DiffRegion, Severity } from "./types.js";

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
  /** Cap on the number of regions returned. After flood-fill, clusters are
   *  ranked by tile-count (a magnitude proxy) and only the top N survive,
   *  so a busy page yields a clean, scannable handful rather than 60 rows. */
  maxRegions?: number;
  /** Areas whose pixels are not compared, the same boxes L1 masks. A change
   *  inside one never makes a region. */
  ignoreAreas?: ReadonlyArray<IgnoreArea>;
  /** When no cluster clears the noise floor but some pixels differ, return
   *  the small changes instead of nothing: one `cosmetic` region per group of
   *  touching changed tiles, boxed tightly around its changed pixels. The
   *  engine sets it for a step that fails, so a failing step always says
   *  where it changed (a timestamp, a price) and auto rules have a region to
   *  match. */
  smallChangesWhenEmpty?: boolean;
}

const DEFAULTS: Required<
  Omit<ExtractOptions, "ignoreAreas" | "smallChangesWhenEmpty">
> = {
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
  // Top 12 by magnitude. A handful of meaningful changed areas reads as a
  // clean region list; the long tail is visible on the
  // canvas overlay anyway.
  maxRegions: 12,
};

// Severity by cluster footprint in tiles (a magnitude proxy). At the
// default 48px tile: ≥25 tiles ≈ 240×240+ (major), ≥8 ≈ 135×135 (minor),
// else a small speckle (cosmetic). Drives list/stepper ordering so the
// biggest visual change surfaces first.
const MAJOR_MIN_TILES = 25;
const MINOR_MIN_TILES = 8;

function severityForSize(tileCount: number): Severity {
  if (tileCount >= MAJOR_MIN_TILES) return "major";
  if (tileCount >= MINOR_MIN_TILES) return "minor";
  return "cosmetic";
}

type PixelCluster = {
  x: number;
  y: number;
  width: number;
  height: number;
  tileCount: number;
};

/** The tiles of one 4-connected component of `dirty` tiles. */
function tileComponents(
  dirty: Uint8Array,
  cols: number,
  rows: number,
): number[][] {
  const visited = new Uint8Array(cols * rows);
  const components: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < dirty.length; start++) {
    if (!dirty[start] || visited[start]) continue;
    const tiles: number[] = [];
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop();
      if (idx === undefined) break;
      tiles.push(idx);
      const cr = (idx / cols) | 0;
      const cc = idx - cr * cols;
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
    components.push(tiles);
  }
  return components;
}

function inIgnoreArea(
  x: number,
  y: number,
  areas: ReadonlyArray<IgnoreArea>,
): boolean {
  for (const a of areas) {
    if (x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height) {
      return true;
    }
  }
  return false;
}

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

  // Count diff pixels per tile in one pass, and box each tile's changed
  // pixels (for the small-change fallback).
  const tileCounts = new Uint32Array(cols * rows);
  const tileMinX = new Int32Array(cols * rows).fill(W);
  const tileMinY = new Int32Array(cols * rows).fill(H);
  const tileMaxX = new Int32Array(cols * rows).fill(-1);
  const tileMaxY = new Int32Array(cols * rows).fill(-1);
  const ignoreAreas = options.ignoreAreas ?? [];
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
        (Math.abs(bR - cR) > tol ||
          Math.abs(bG - cG) > tol ||
          Math.abs(bB - cB) > tol) &&
        (ignoreAreas.length === 0 || !inIgnoreArea(x, y, ignoreAreas))
      ) {
        const tileCol = (x / tile) | 0;
        const tIdx = tileRow * cols + tileCol;
        tileCounts[tIdx] = (tileCounts[tIdx] ?? 0) + 1;
        if (x < tileMinX[tIdx]!) tileMinX[tIdx] = x;
        if (y < tileMinY[tIdx]!) tileMinY[tIdx] = y;
        if (x > tileMaxX[tIdx]!) tileMaxX[tIdx] = x;
        if (y > tileMaxY[tIdx]!) tileMaxY[tIdx] = y;
      }
    }
  }

  const minPixelsPerTile = opts.minTileDiffRatio * tile * tile;
  for (let i = 0; i < dirty.length; i++) {
    if ((tileCounts[i] ?? 0) >= minPixelsPerTile) dirty[i] = 1;
  }

  // Flood-fill 4-connected tile components.
  const clusters: PixelCluster[] = [];
  for (const tiles of tileComponents(dirty, cols, rows)) {
    if (tiles.length < opts.minClusterTiles) continue;
    let minR = rows,
      maxR = -1,
      minC = cols,
      maxC = -1;
    for (const idx of tiles) {
      const cr = (idx / cols) | 0;
      const cc = idx - cr * cols;
      if (cr < minR) minR = cr;
      if (cr > maxR) maxR = cr;
      if (cc < minC) minC = cc;
      if (cc > maxC) maxC = cc;
    }
    const x = minC * tile;
    const y = minR * tile;
    const width = Math.min((maxC + 1) * tile, W) - x;
    const height = Math.min((maxR + 1) * tile, H) - y;
    clusters.push({ x, y, width, height, tileCount: tiles.length });
  }

  if (clusters.length === 0 && options.smallChangesWhenEmpty) {
    return smallChangeRegions(
      tileCounts,
      { tileMinX, tileMinY, tileMaxX, tileMaxY },
      cols,
      rows,
      opts.maxRegions,
    );
  }

  // Rank by magnitude (tile-count), keep the top N, assign severity tiers.
  clusters.sort((a, b) => b.tileCount - a.tileCount);
  return clusters.slice(0, opts.maxRegions).map((cl, i) => ({
    id: `l1-pixel-${i}`,
    severity: severityForSize(cl.tileCount),
    category: "image",
    bbox: { x: cl.x, y: cl.y, width: cl.width, height: cl.height },
    description: `Pixel diff cluster (${cl.tileCount} tiles, ${cl.width}×${cl.height})`,
    // "l1_pixel" (vs "l1", the synthetic whole-diff source) tags these as
    // image-derived pixel-cluster regions — the primary "what changed"
    // signal surfaced in the diff viewer's region list + stepper (ADR-047).
    source: "l1_pixel",
  }));
}

/**
 * The fallback of {@link ExtractOptions.smallChangesWhenEmpty}: every group of
 * touching tiles with any changed pixel, boxed tightly around those pixels.
 * Largest (by changed-pixel count) first.
 */
function smallChangeRegions(
  tileCounts: Uint32Array,
  boxes: {
    tileMinX: Int32Array;
    tileMinY: Int32Array;
    tileMaxX: Int32Array;
    tileMaxY: Int32Array;
  },
  cols: number,
  rows: number,
  maxRegions: number,
): DiffRegion[] {
  const changed = new Uint8Array(cols * rows);
  for (let i = 0; i < changed.length; i++) {
    if ((tileCounts[i] ?? 0) > 0) changed[i] = 1;
  }
  const groups = tileComponents(changed, cols, rows).map((tiles) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      pixels = 0;
    for (const idx of tiles) {
      x0 = Math.min(x0, boxes.tileMinX[idx]!);
      y0 = Math.min(y0, boxes.tileMinY[idx]!);
      x1 = Math.max(x1, boxes.tileMaxX[idx]!);
      y1 = Math.max(y1, boxes.tileMaxY[idx]!);
      pixels += tileCounts[idx] ?? 0;
    }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels };
  });
  groups.sort((a, b) => b.pixels - a.pixels);
  return groups.slice(0, maxRegions).map((g, i) => ({
    id: `l1-pixel-${i}`,
    severity: "cosmetic",
    category: "image",
    bbox: { x: g.x, y: g.y, width: g.width, height: g.height },
    description: `Small pixel change (${g.pixels} px, ${g.width}×${g.height})`,
    source: "l1_pixel",
  }));
}
