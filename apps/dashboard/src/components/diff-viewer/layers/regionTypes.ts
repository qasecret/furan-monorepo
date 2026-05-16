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
}
