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
  source: "l1" | "l2" | "axe";
  /**
   * For L2 regions: the diff-dom op's `route` (path through the DOM
   * tree as child indices). The diff worker uses this with the
   * candidate DOM + element-map sidecar to resolve a real bbox via
   * `l2-bbox-resolver.ts`. Engine doesn't touch storage or the
   * element-map; it just forwards what diff-dom already gave us.
   *
   * Absent for L1 regions and for the L2 overflow sentinel.
   */
  route?: number[];
  /**
   * For axe regions: the axe-core `target` selector array (verbatim).
   * The diff worker uses this with the candidate DOM + element-map
   * sidecar to resolve a real bbox via `axe-bbox-resolver.ts`.
   *
   * Absent for L1 and L2 regions.
   *
   * v1.0 uses only `axeTarget[0]` (multi-frame iframe traversal is
   * deferred — Furan captures a single frame today).
   */
  axeTarget?: string[];
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
  engine: ImageComparison;
  engineConfig: EngineConfig;
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
