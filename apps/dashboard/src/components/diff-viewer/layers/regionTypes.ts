/**
 * Shared types for the diff-viewer overlay layers.
 *
 * T9: kept local rather than derived from the tRPC AppRouter to avoid
 * pulling the inferred-output chain through pixi-side modules. The shape
 * matches @furan/db's `diff_regions` row exactly.
 */
export type Severity = "breaking" | "major" | "minor" | "cosmetic" | "none";

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffRegion {
  id: string;
  severity: string; // narrowed to Severity at render time; tolerant of legacy values
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
