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

export type ImageComparison = "pixelmatch" | "looks_same" | "odiff";

export interface EngineConfig {
  /** Engine-internal sensitivity. Pixelmatch: 0..1 strict→loose.
   *  Looks-same / odiff: passed through but used only as a hint. */
  threshold: number;
  /** Treat antialiased pixels as equal. Maps to odiff `antialiasing: true`,
   *  pixelmatch `includeAA: false`, looks-same `antialiasingTolerance > 0`. */
  ignoreAntialiasing: boolean;
  /** Reserved for v1.1+; plumbed but currently a no-op. */
  allowDiffDimensions: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  threshold: 0.1,
  ignoreAntialiasing: true,
  allowDiffDimensions: false,
};

export interface ProjectDiffConfig {
  diffThreshold: number;
  l2Enabled: boolean;
  ignoreAreas?: Array<{ x: number; y: number; width: number; height: number }>;
  /** Defaults to "odiff" when omitted (backwards-compat for callers that
   *  predate the engine-selection feature). */
  engine?: ImageComparison;
  /** Defaults to DEFAULT_ENGINE_CONFIG when omitted. */
  engineConfig?: EngineConfig;
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
