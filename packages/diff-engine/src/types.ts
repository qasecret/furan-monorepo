export type Severity = "breaking" | "major" | "minor" | "cosmetic" | "none";
export type RegionCategory =
  | "text"
  | "color"
  | "layout"
  | "image"
  | "structural";

export interface DiffRegion {
  id: string;
  severity: Severity;
  category: RegionCategory;
  bbox: { x: number; y: number; width: number; height: number };
  description: string;
  source: "l1" | "l2";
}

export interface ProjectDiffConfig {
  diffThreshold: number;
  l2Enabled: boolean;
  ignoreAreas?: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface DiffResult {
  passed: boolean;
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageBytes: Buffer;
  regions: DiffRegion[];
  ranTiers: Array<"l1" | "l2">;
  durationMs: { l1: number; l2: number | null };
}
