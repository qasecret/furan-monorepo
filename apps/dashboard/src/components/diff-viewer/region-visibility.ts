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
