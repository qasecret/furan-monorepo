import { prng, type ImageChange } from "../seed/images.js";

/**
 * The pipeline suite's arithmetic (spec §5.2), pure so it is unit-tested apart
 * from the stack that feeds it.
 */

/** P1: checkpoint diffs per step uploaded. Linear diff work is exactly 1. */
export function amplification(diffs: number, steps: number): number {
  if (!(steps > 0))
    throw new RangeError(`steps must be positive, got ${steps}`);
  return diffs / steps;
}

/**
 * P4: the observed result rate as a share of the worker's ideal, which is
 * `concurrency` jobs each taking the single-step time.
 */
export function throughputRatio(
  observedPerSec: number,
  singleStepSec: number,
  concurrency = 4,
): number {
  return observedPerSec / (concurrency / singleStepSec);
}

/**
 * P4's single-step cost (ruling R19): the mean of the histogram observations
 * between two reads of it, `Δsum / Δcount`. Read on
 * `furan_diff_job_duration_seconds{outcome="completed"}` around one-step jobs,
 * it is the worker's time per step, free of any polling interval.
 */
export function meanJobSeconds(
  before: { count: number; sum: number },
  after: { count: number; sum: number },
): number {
  const jobs = after.count - before.count;
  if (!(jobs > 0)) {
    throw new RangeError(`no job was observed between the two reads`);
  }
  return (after.sum - before.sum) / jobs;
}

/** P6: `testRun_updated` events above the allowance of status changes + 2. */
export function excessEvents(
  testRunUpdated: number,
  statusChanges: number,
): number {
  return Math.max(0, testRunUpdated - (statusChanges + 2));
}

/** One `diff_regions` row, as the race checks compare it. */
export interface RegionRow {
  screenshotId: string;
  severity: string;
  /** The bbox as stored: an object, or its jsonb text. */
  bbox: unknown;
  source: string;
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A bbox by value: jsonb text is parsed first, then keys are sorted. */
function bboxKey(bbox: unknown): string {
  if (typeof bbox === "string") {
    try {
      return canonicalJson(JSON.parse(bbox));
    } catch {
      return JSON.stringify(bbox);
    }
  }
  return canonicalJson(bbox);
}

/** The identity of a region: (screenshot, severity, bbox, source). */
export function regionKey(region: RegionRow): string {
  return JSON.stringify([
    region.screenshotId,
    region.severity,
    bboxKey(region.bbox),
    region.source,
  ]);
}

/** P5: rows whose (screenshot, severity, bbox, source) an earlier row already had. */
export function findDuplicates(regions: readonly RegionRow[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const region of regions) {
    const key = regionKey(region);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

/** One step of a run: its screenshot id and verdict (NULL = not diffed). */
export interface StepRow {
  id: string;
  verdict: string | null;
}

/** P5's checks on the state the race left. */
export function raceLosses(
  steps: readonly StepRow[],
  regions: readonly RegionRow[],
): {
  duplicates: number;
  nullVerdicts: number;
  unresolvedWithoutRegion: number;
} {
  const withRegion = new Set(regions.map((r) => r.screenshotId));
  return {
    duplicates: findDuplicates(regions),
    nullVerdicts: steps.filter((s) => s.verdict === null).length,
    unresolvedWithoutRegion: steps.filter(
      (s) => s.verdict === "unresolved" && !withRegion.has(s.id),
    ).length,
  };
}

/** A run's steps and regions at one moment. */
export interface RunSnapshot {
  steps: readonly StepRow[];
  regions: readonly RegionRow[];
}

/**
 * P5's ground truth: the steps (counted once each) whose verdict or region
 * set differs between the state the race left and a quiet re-diff of it. The
 * regions are compared as sets of `regionKey` (spec §5.2), so a duplicate the
 * re-diff removed is not counted again here: `findDuplicates` counts it.
 */
export function stepDifferences(
  before: RunSnapshot,
  after: RunSnapshot,
): number {
  const byStep = (snapshot: RunSnapshot): Map<string, string> => {
    const keys = new Map<string, Set<string>>();
    for (const region of snapshot.regions) {
      const set = keys.get(region.screenshotId) ?? new Set<string>();
      set.add(regionKey(region));
      keys.set(region.screenshotId, set);
    }
    const sorted = (id: string): string[] => [...(keys.get(id) ?? [])].sort();
    const out = new Map<string, string>();
    for (const step of snapshot.steps) {
      out.set(step.id, JSON.stringify([step.verdict, sorted(step.id)]));
    }
    // Regions of a screenshot the step list does not name still count.
    for (const id of keys.keys()) {
      if (!out.has(id)) out.set(id, JSON.stringify([null, sorted(id)]));
    }
    return out;
  };
  const a = byStep(before);
  const b = byStep(after);
  let differences = 0;
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(id) !== b.get(id)) differences += 1;
  }
  return differences;
}

/** Share of steps per change against the baseline (spec §2.2). */
const SMALL_SHARE = 0.25;
const LARGE_SHARE = 0.05;

/**
 * The change of each of `n` steps: exact quotas of 70% `none`, 25% `small`
 * and 5% `large` (rounded; `none` takes the remainder), placed by a shuffle
 * seeded with `seed`, so a run uploads the same images every time.
 */
export function changeMix(n: number, seed: number): ImageChange[] {
  const small = Math.round(n * SMALL_SHARE);
  const large = Math.round(n * LARGE_SHARE);
  const mix: ImageChange[] = [
    ...Array<ImageChange>(large).fill("large"),
    ...Array<ImageChange>(small).fill("small"),
    ...Array<ImageChange>(Math.max(0, n - small - large)).fill("none"),
  ];
  const rand = prng(seed);
  for (let i = mix.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [mix[i], mix[j]] = [mix[j]!, mix[i]!];
  }
  return mix;
}

/**
 * When P5's race acts, as 1-based step numbers: the ignore region goes on
 * step 3 after step 10 is uploaded, and step 5 is approved and undone after
 * step 20, on the 50-step run (spec §5.2). A smaller run scales those points
 * by the same fractions, but never acts before the step it acts on exists.
 */
export function raceSchedule(n: number): {
  ignoreStep: number;
  ignoreAfter: number;
  approveStep: number;
  approveAfter: number;
} {
  if (n < 5) throw new RangeError(`the race needs 5 steps, got ${n}`);
  return {
    ignoreStep: 3,
    ignoreAfter: Math.max(3, Math.round(n * 0.2)),
    approveStep: 5,
    approveAfter: Math.max(5, Math.round(n * 0.4)),
  };
}

/**
 * Result latencies (ms): result time minus upload time. A step that got no
 * result counts at `timeoutMs`: a failed sample, never a dropped one.
 */
export function latencySamples(
  steps: readonly { uploadedAt: number; resultAt?: number }[],
  timeoutMs: number,
): { samples: number[]; timedOut: number } {
  let timedOut = 0;
  const samples = steps.map((step) => {
    if (step.resultAt === undefined) {
      timedOut += 1;
      return timeoutMs;
    }
    return step.resultAt - step.uploadedAt;
  });
  return { samples, timedOut };
}

/**
 * Results per second from the first result to the last: the results after the
 * first over that span. The span is at least `minSpanMs` (the poll interval),
 * since results seen in one poll landed somewhere inside it.
 */
export function ratePerSec(
  timesMs: readonly number[],
  minSpanMs: number,
): number {
  if (timesMs.length < 2) {
    throw new RangeError(`a rate needs two results, got ${timesMs.length}`);
  }
  let first = Infinity;
  let last = -Infinity;
  for (const t of timesMs) {
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const spanMs = Math.max(last - first, minSpanMs);
  return (timesMs.length - 1) / (spanMs / 1000);
}

/** A time span (`performance.now()` ms): a request in flight. */
export interface Span {
  start: number;
  end: number;
}

/**
 * P5's note (ruling R20b): the uploads (1-based) in flight at some moment
 * while `branch` was, so the note can say which overlaps actually happened.
 * Touching ends (one ended as the other started) do not overlap.
 */
export function overlappingUploads(
  uploads: readonly Span[],
  branch: Span,
): number[] {
  const out: number[] = [];
  uploads.forEach((upload, i) => {
    if (upload.start < branch.end && upload.end > branch.start) out.push(i + 1);
  });
  return out;
}

/** Step numbers as ranges, for a note: `[4, 5, 6, 8]` → `4–6, 8`. */
export function formatSteps(steps: readonly number[]): string {
  if (steps.length === 0) return "none";
  const sorted = [...steps].sort((a, b) => a - b);
  const parts: string[] = [];
  let first = sorted[0]!;
  let last = first;
  for (const step of [...sorted.slice(1), Infinity]) {
    if (step === last + 1) {
      last = step;
      continue;
    }
    parts.push(first === last ? `${first}` : `${first}–${last}`);
    first = step;
    last = step;
  }
  return parts.join(", ");
}
