import type { DiffRegion } from "./layers/regionTypes";

/**
 * Synthetic audit rows, not findings: the dynamic-text OCR decisions, and the
 * content/colour changes the layout match level suppressed (ADR-053). They
 * mirror the diff engine's EXCLUDED_SOURCES.
 */
const AUDIT_SOURCES: ReadonlySet<string> = new Set([
  "dynamic_text",
  "layout_suppressed",
]);

/**
 * True when `region` is an audit row and the viewer has not asked to see
 * suppressed rows. The one rule behind the stepper order and the region list,
 * so the two never disagree on what a checkpoint's regions are.
 */
export function isRegionHidden(
  region: DiffRegion,
  opts: { showSuppressed: boolean },
): boolean {
  return !opts.showSuppressed && AUDIT_SOURCES.has(region.source);
}

/** What decides whether a region shows, on every region surface. */
export interface RegionVisibility {
  /** "Show suppressed": the audit rows show too. */
  showSuppressed: boolean;
  /** "Hide displacement": position-only (layout) changes are hidden. */
  hideDisplacement: boolean;
}

/**
 * The one visibility rule for every surface that shows regions: the region
 * list, the canvas's severity rectangles and highlight shading, a click's
 * hit-test on the canvas and the "has differences" badge (R10), and the diff
 * stepper's order (which keeps the audit rows out). A region the list hides
 * is never drawn or selectable on the canvas.
 */
export function isRegionShown(
  region: DiffRegion,
  { showSuppressed, hideDisplacement }: RegionVisibility,
): boolean {
  if (isRegionHidden(region, { showSuppressed })) return false;
  return !(hideDisplacement && region.category === "layout");
}
