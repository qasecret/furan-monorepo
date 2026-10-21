/**
 * The seed's shapes (spec §3): how much history the scratch project holds.
 *
 * Bump `SHAPE_VERSION` whenever a shape or the way it is written changes: a
 * `--reuse` run reseeds a scratch database whose stored version differs, so a
 * stale seed is never measured as it is.
 */
export const SHAPE_VERSION = 1;

export const PIPELINE_SETS = [
  "pipeline-50",
  "pipeline-200",
  "pipeline-500",
] as const;
export type PipelineSet = (typeof PIPELINE_SETS)[number];

export type ShapeName = "large" | "smoke";

export interface Shape {
  name: ShapeName;
  /** Reviewer members (`editor`); reviewer 0 can log in (browser suite). */
  reviewers: number;
  /** Runs in the full nightly suite. */
  nightlyRuns: number;
  /** Steps per nightly run. */
  nightlySteps: number;
  /** Nightly batches of the full suite; the newest is the review batch. */
  nightlies: number;
  /** Nights between approved baselines per variation. */
  baselineEvery: number;
  /** PR batches, across `branches` branches. */
  prBatches: number;
  prRuns: number;
  prSteps: number;
  branches: number;
  /** Steps of the crawler-style long run. */
  longRunSteps: number;
  /** Earlier captures of the long run (see `longRunCaptures`). */
  longRunHistory: number;
  /** Steps of each pipeline set (variations with an approved baseline). */
  pipelineSets: Record<PipelineSet, number>;
  /** Share of steps pending / decided in the review mix (the rest passed). */
  pendingPct: number;
  decidedPct: number;
  /** Share of runs `running` or `aborted`, so not reviewable. */
  notReviewablePct: number;
  /** Diff regions on each step that did not pass. */
  regionsPerChangedStep: { min: number; max: number };
  /** Generated PNGs shared by the history (content-addressed keys). */
  imagePool: number;
}

const MIX = {
  pendingPct: 5,
  decidedPct: 40,
  notReviewablePct: 3,
  regionsPerChangedStep: { min: 2, max: 5 },
  imagePool: 24,
} as const;

export const shapes: Record<ShapeName, Shape> = {
  large: {
    name: "large",
    reviewers: 20,
    nightlyRuns: 1000,
    nightlySteps: 5,
    nightlies: 200,
    baselineEvery: 10,
    prBatches: 9800,
    prRuns: 3,
    prSteps: 3,
    branches: 40,
    longRunSteps: 500,
    longRunHistory: 200,
    pipelineSets: {
      "pipeline-50": 50,
      "pipeline-200": 200,
      "pipeline-500": 500,
    },
    ...MIX,
  },
  smoke: {
    name: "smoke",
    reviewers: 3,
    nightlyRuns: 10,
    nightlySteps: 3,
    nightlies: 5,
    baselineEvery: 2,
    prBatches: 15,
    prRuns: 2,
    prSteps: 2,
    branches: 3,
    longRunSteps: 20,
    longRunHistory: 5,
    pipelineSets: {
      "pipeline-50": 10,
      "pipeline-200": 10,
      "pipeline-500": 10,
    },
    ...MIX,
  },
};

/** True unless the scratch database holds a seed of the current version. */
export function needsReseed(stored: number | null, current: number): boolean {
  return stored !== current;
}

/**
 * Earlier captures of the long run actually seeded. Each is one extra run in
 * one of the nightlies before the newest (Ruling PF3), the most recent ones
 * first, so there are at most `nightlies - 1` of them: 199 for `large`, 4 for
 * `smoke`.
 */
export function longRunCaptures(shape: Shape): number {
  return Math.max(0, Math.min(shape.longRunHistory, shape.nightlies - 1));
}

/**
 * The nights (0 = oldest) on which a baseline is recorded: every
 * `baselineEvery`-th of the nightlies before the newest. The newest nightly is
 * the review batch, so it records none.
 */
export function baselineNights(shape: Shape): number[] {
  const nights: number[] = [];
  for (let n = 0; n <= shape.nightlies - 2; n += shape.baselineEvery) {
    nights.push(n);
  }
  return nights;
}

/** Index (0 = oldest) of the first nightly that holds a long-run capture. */
export function firstLongRunNight(shape: Shape): number {
  return shape.nightlies - 1 - longRunCaptures(shape);
}

/** Steps across all pipeline sets. */
export function pipelineSteps(shape: Shape): number {
  return PIPELINE_SETS.reduce((sum, set) => sum + shape.pipelineSets[set], 0);
}

/**
 * Rows the seed writes for the main project (`Seeded.projectId`); the
 * worst-case project (`resolvedProjectId`) is separate.
 *
 * - builds: the nightlies (the newest included), the PR batches, and the long
 *   run's own one-run batch.
 * - runs: every nightly's suite runs, one long-run capture in each of the
 *   latest earlier nightlies, the current long run, one approved run per
 *   pipeline set (in the oldest nightly), and the PR runs.
 * - baselines: each baseline night's suite and long-run steps, and every
 *   pipeline step.
 */
export function expectedRows(shape: Shape): {
  builds: number;
  runs: number;
  screenshots: number;
  baselines: number;
} {
  const history = longRunCaptures(shape);
  const nights = baselineNights(shape);
  const firstLong = firstLongRunNight(shape);
  const longNights = nights.filter((n) => n >= firstLong).length;
  return {
    builds: shape.nightlies + shape.prBatches + 1,
    runs:
      shape.nightlies * shape.nightlyRuns +
      history +
      1 +
      PIPELINE_SETS.length +
      shape.prBatches * shape.prRuns,
    screenshots:
      shape.nightlies * shape.nightlyRuns * shape.nightlySteps +
      (history + 1) * shape.longRunSteps +
      pipelineSteps(shape) +
      shape.prBatches * shape.prRuns * shape.prSteps,
    baselines:
      nights.length * shape.nightlyRuns * shape.nightlySteps +
      longNights * shape.longRunSteps +
      pipelineSteps(shape),
  };
}

/** Every seeded step is captured in this browser and viewport. */
export const SEED_BROWSER = "chromium";
export const SEED_VIEWPORT = "1366x768";

/**
 * Step `index` (0-based) of a pipeline set: its variation identity on `main`
 * and the `generatePng` arguments of its baseline image. The pipeline suite
 * uploads `generatePng(kind, seed, change)` under the same name, viewport and
 * browser, so its runs diff against these baselines. 70% are screens and 30%
 * full pages; seeds never repeat across sets or with the image pool.
 */
export function pipelineStep(
  set: PipelineSet,
  index: number,
): {
  name: string;
  viewport: string;
  browser: string;
  kind: "screen" | "page";
  seed: number;
} {
  const setNo = PIPELINE_SETS.indexOf(set);
  return {
    name: `${set}/step-${String(index + 1).padStart(4, "0")}`,
    viewport: SEED_VIEWPORT,
    browser: SEED_BROWSER,
    kind: index % 10 < 7 ? "screen" : "page",
    seed: 1_000_000 * (setNo + 1) + index,
  };
}

/**
 * Image `index` of the shared pool: 70% screens (the first ones), the rest
 * pages. Seeds 1..imagePool, apart from the pipeline seeds.
 */
export function poolImage(
  shape: Shape,
  index: number,
): { kind: "screen" | "page"; seed: number } {
  return {
    kind: index < poolScreens(shape) ? "screen" : "page",
    seed: index + 1,
  };
}

/** How many pool images are screens. */
export function poolScreens(shape: Shape): number {
  return Math.round(shape.imagePool * 0.7);
}

/** Names and emails the seed writes (also how a reused seed is found). */
export const SEED_NAMES = {
  project: (shape: Shape) => `scale-${shape.name}`,
  resolvedProject: (shape: Shape) => `scale-${shape.name}-resolved`,
  adminEmail: "scale-admin@scale.example",
  reviewerEmail: (i: number) =>
    `scale-reviewer-${String(i + 1).padStart(2, "0")}@scale.example`,
  newestNightly: (shape: Shape) => `nightly-${shape.nightlies - 1}`,
  longRunBuild: "long-run",
  longRunName: "crawler",
  longRunStep: (i: number) => `crawl/page-${String(i).padStart(4, "0")}`,
} as const;
