/**
 * Shared types for the diff-viewer overlay layers.
 *
 * T9: kept local rather than derived from the tRPC AppRouter to avoid
 * pulling the inferred-output chain through pixi-side modules. The shape
 * matches @furan/db's `diff_regions` row exactly.
 */
import { isSeverity, type Severity } from "@furan/shared-types";

// The severity tiers live in @furan/shared-types; re-exported here so the
// viewer files keep importing them with the other region types.
export type { Severity } from "@furan/shared-types";

/**
 * A region's severity as a `Severity`. `DiffRegion.severity` is a plain string
 * (rows persisted before a tier existed can carry any value), so every reader
 * narrows it through here: an unknown value counts as `none`.
 */
export function asSeverity(value: string): Severity {
  return isSeverity(value) ? value : "none";
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffRegion {
  id: string;
  severity: string; // narrow with asSeverity(); tolerant of legacy values
  category: string;
  bbox: BBox | unknown; // jsonb; tolerate non-object rows defensively
  description: string;
  source: string;
  /** Non-null only for `source === "dynamic_text"` audit rows. The OCR
   * text extracted from the candidate crop (trimmed). */
  ocrText?: string | null;
  /** Non-null only for `source === "dynamic_text"` audit rows. Whether
   * the OCR text matched the region's regex. */
  ocrMatched?: boolean | null;
  viewport?: string | null;
  /** v1.1.20+: which screenshot (checkpoint) this region was detected
   *  on. Null for legacy rows from runs persisted before the column was
   *  added — the DiffViewer treats null as "show on every checkpoint"
   *  so legacy runs degrade gracefully rather than disappearing. */
  screenshotId?: string | null;
}
