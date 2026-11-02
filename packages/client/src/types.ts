/** How strictly a checkpoint is compared with its baseline. */
export type MatchLevel =
  "Strict" | "Layout" | "Content" | "IgnoreColors" | "Dynamic";

export const MATCH_LEVELS: readonly MatchLevel[] = [
  "Strict",
  "Layout",
  "Content",
  "IgnoreColors",
  "Dynamic",
];

/** A rectangle in screenshot pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingBox extends Box {
  maxUpOffset?: number;
  maxDownOffset?: number;
  maxLeftOffset?: number;
  maxRightOffset?: number;
}

export interface AccessibilityBox extends Box {
  type: "LargeText" | "RegularText" | "BoldText" | "GraphicalObject";
}

/** The five region kinds a checkpoint upload carries (the `regions` field). */
export interface Regions {
  ignore: Box[];
  layout: Box[];
  floating: FloatingBox[];
  content: Box[];
  accessibility: AccessibilityBox[];
}

/** A build (the dashboard's batch). */
export interface Build {
  id: string;
  projectId: string;
  ciBuildId: string | null;
  branchName: string | null;
  name: string | null;
  number: number | null;
}

/** A run (one test), as `GET /runs/:id` returns it. */
export interface Run {
  id: string;
  projectId: string;
  buildId: string;
  name: string;
  /** The server's `run_status`; a newer server may send values this client doesn't know. */
  status: string;
  branchName: string | null;
  checkpointCount: number | null;
  autoApproved: boolean;
}

export interface CheckpointRef {
  checkpointId: string;
  testVariationId: string;
}

/**
 * A test's outcome:
 * - `passed`: matched its baseline (or its first baseline was saved);
 * - `new`: no baseline yet, waiting for a first approval;
 * - `failed`: changed (unresolved), or failed or aborted;
 * - `error`: no verdict (an api error or the deadline);
 * - `skipped`: it had no checks, so it was aborted, not completed;
 * - `uploaded`: completed without waiting for a verdict.
 */
export type ResultStatus =
  "passed" | "new" | "failed" | "error" | "skipped" | "uploaded";

export interface TestResult {
  name: string;
  runId: string;
  status: ResultStatus;
  /** The run status the verdict came from, when there was one. */
  serverStatus: string | null;
  steps: string[];
  url: string | null;
  error?: Error;
}

/** The api's per-file cap on a screenshot upload. */
export const MAX_PNG_BYTES = 50 * 1024 * 1024;

/** The api's cap on boxes of one region kind per checkpoint. */
export const MAX_REGIONS_PER_KIND = 50;
