export type Severity = "breaking" | "major" | "minor" | "cosmetic" | "none";
export type RegionCategory =
  | "text"
  | "color"
  | "layout"
  | "image"
  | "structural"
  | "accessibility";

export interface DiffRegion {
  id: string;
  severity: Severity;
  category: RegionCategory;
  bbox: { x: number; y: number; width: number; height: number };
  description: string;
  source: "l1" | "l1_pixel" | "axe";
  /**
   * For axe regions: the axe-core `target` selector array (verbatim).
   * The diff worker uses this with the candidate DOM + element-map
   * sidecar to resolve a real bbox via `axe-bbox-resolver.ts`.
   *
   * Absent for L1 regions.
   *
   * v1.0 uses only `axeTarget[0]` (multi-frame iframe traversal is
   * deferred — Furan captures a single frame today).
   */
  axeTarget?: string[];
}

export type ImageComparison = "pixelmatch" | "looks_same" | "odiff" | "vlm";

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
  ignoreAreas?: Array<{ x: number; y: number; width: number; height: number }>;
  engine: ImageComparison;
  engineConfig: EngineConfig;
}

export interface DiffResult {
  passed: boolean;
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageBytes: Buffer;
  regions: DiffRegion[];
  ranTiers: Array<"l1">;
  durationMs: { l1: number };
  /**
   * Tier 1.4 follow-up: when non-null, the L1 displacement pass
   * detected a uniform shift and aligned the candidate before
   * running the engine. `diffPercent`, `pixelMismatchCount`, and
   * `diffImageBytes` reflect the POST-alignment comparison.
   *
   * Surfaced on the screenshot row's JSON `results` column for
   * telemetry. Absent when alignment didn't fire (default,
   * `ignoreDisplacements = false`, low confidence, or shift
   * capped).
   *
   * Coordinates are in ORIGINAL-image pixels (downsample factor
   * has already been multiplied back in).
   */
  displacementVector?: { dx: number; dy: number; confidence: number };
}
