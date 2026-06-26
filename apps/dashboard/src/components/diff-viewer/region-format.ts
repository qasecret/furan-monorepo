import type { BBox, DiffRegion } from "./layers/regionTypes";

/**
 * Pixel-diff descriptions carry an engine-internal "(N tiles, W×H)"
 * parenthetical — the tile count is clustering jargon and the size is shown
 * as its own chip, so strip the whole tail. VLM prose and axe messages don't
 * match the pattern and pass through untouched.
 */
export function cleanDescription(desc: string): string {
  return desc.replace(/\s*\(\d+\s+tiles?(?:,[^)]*)?\)\s*$/i, "").trim();
}

/** Compact "W×H" from a bbox, or null when it's missing / zero-area. */
export function sizeLabel(b: BBox | unknown): string | null {
  if (
    b &&
    typeof b === "object" &&
    "width" in b &&
    "height" in b &&
    typeof (b as BBox).width === "number" &&
    typeof (b as BBox).height === "number"
  ) {
    const w = Math.round((b as BBox).width);
    const h = Math.round((b as BBox).height);
    if (w > 0 && h > 0) return `${w}×${h}`;
  }
  return null;
}

/**
 * Signature for collapsing visually-identical region rows. Two regions with
 * the same severity, category, source, cleaned description, size (and OCR
 * text, for dynamic-text rows) render as one "×N" row. Position is
 * intentionally excluded — distinct positions are still shown as separate
 * highlights on the canvas and stepped through individually; the list just
 * stops repeating the same card. The signature is `JSON.stringify` of the
 * field tuple — quoting and escaping each field means two different tuples
 * can never collide into the same string (no separator-char ambiguity).
 */
export function regionSignature(r: DiffRegion): string {
  return JSON.stringify([
    r.severity,
    r.category,
    r.source,
    cleanDescription(r.description),
    sizeLabel(r.bbox) ?? "",
    r.ocrText ?? "",
  ]);
}

/** A run of regions that share a {@link regionSignature}. */
export interface RegionGroup {
  /** The first region in the group — drives the row's display + bbox. */
  representative: DiffRegion;
  /** Every region id in the group (≥1). Used for count + selection state. */
  memberIds: string[];
}

/**
 * Collapse an already-filtered/sorted region list into signature groups,
 * preserving first-occurrence order so the existing severity-then-area sort
 * still drives row order.
 */
export function groupRegions(regions: DiffRegion[]): RegionGroup[] {
  const bySig = new Map<string, RegionGroup>();
  for (const r of regions) {
    const sig = regionSignature(r);
    const existing = bySig.get(sig);
    if (existing) existing.memberIds.push(r.id);
    else bySig.set(sig, { representative: r, memberIds: [r.id] });
  }
  return Array.from(bySig.values());
}
