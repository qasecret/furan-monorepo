import { prng, type ImageChange } from "../seed/images.js";
import {
  PIPELINE_SETS,
  pipelineStep,
  type PipelineSet,
  type Shape,
  type ShapeName,
} from "../seed/shape.js";

/**
 * The pipeline suite's arithmetic (spec §5.2), pure so it is unit-tested apart
 * from the stack that feeds it.
 */

/**
 * P1: checkpoint diffs per step uploaded. Linear diff work is exactly 1: each
 * upload queues one job for its own step, a committed job observes 1 in
 * `furan_diff_job_checkpoints` and a stale one (a newer version of its step
 * was queued) observes 0, so a re-diff never counts twice.
 */
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
  /**
   * Its diff failed for good (`diff_failed_at` set): the verdict reads
   * `unresolved` and the step has no regions, but it has no result either.
   */
  failed?: boolean;
}

/**
 * P5's checks on the state the race left. A failed step is a lost result,
 * counted on its own: it is not also an unresolved step without a region.
 */
export function raceLosses(
  steps: readonly StepRow[],
  regions: readonly RegionRow[],
): {
  duplicates: number;
  nullVerdicts: number;
  unresolvedWithoutRegion: number;
  failedSteps: number;
} {
  const withRegion = new Set(regions.map((r) => r.screenshotId));
  return {
    duplicates: findDuplicates(regions),
    nullVerdicts: steps.filter((s) => s.verdict === null).length,
    unresolvedWithoutRegion: steps.filter(
      (s) =>
        s.verdict === "unresolved" &&
        s.failed !== true &&
        !withRegion.has(s.id),
    ).length,
    failedSteps: steps.filter((s) => s.failed === true).length,
  };
}

/**
 * P5's quiet re-diff (`runs.setDiffThresholdOverride`) queues one job per step
 * whose verdict is not `new` (a step with no baseline pair is never re-diffed
 * by a threshold), failed and undiffed steps included. Each of those jobs
 * diffs one checkpoint, so the re-diff ran in full only if the checkpoint
 * diffs it added are at least this many.
 */
export function pairedSteps(steps: readonly StepRow[]): number {
  return steps.filter((s) => s.verdict !== "new").length;
}

/** A run's steps and regions at one moment. */
export interface RunSnapshot {
  steps: readonly StepRow[];
  regions: readonly RegionRow[];
}

/**
 * P5's ground truth: the steps (counted once each) whose verdict, failure or
 * region set differs between the state the race left and a quiet re-diff of
 * it. The regions are compared as sets of `regionKey` (spec §5.2), so a
 * duplicate the re-diff removed is not counted again here: `findDuplicates`
 * counts it.
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
      out.set(
        step.id,
        JSON.stringify([step.verdict, step.failed === true, sorted(step.id)]),
      );
    }
    // Regions of a screenshot the step list does not name still count.
    for (const id of keys.keys()) {
      if (!out.has(id)) out.set(id, JSON.stringify([null, false, sorted(id)]));
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

/** The change mix's shuffle seed of a set: a fixed base plus the set's index. */
export function mixSeed(set: PipelineSet): number {
  return 0x5ca1e + PIPELINE_SETS.indexOf(set);
}

/** Screens, pages and changes of a set's first `changes.length` steps. */
export function mixCounts(
  set: PipelineSet,
  changes: readonly ImageChange[],
): {
  screen: number;
  page: number;
  none: number;
  small: number;
  large: number;
} {
  const out = { screen: 0, page: 0, none: 0, small: 0, large: 0 };
  changes.forEach((change, i) => {
    out[pipelineStep(set, i).kind] += 1;
    out[change] += 1;
  });
  return out;
}

/**
 * P4's one-step runs per shape (ruling R19a): the size at which their mix is
 * exactly `pipeline-200`'s, in screens/pages and none/small/large. Large:
 * 20 of 200 (14/6, 14/5/1); smoke: 10, all of its `pipeline-200`.
 */
export const SINGLE_STEP_RUNS: Record<ShapeName, number> = {
  large: 20,
  smoke: 10,
};

/** The changes of P4's one-step runs: `pipeline-200`'s steps 0.. with its mix. */
export function singleStepChanges(shape: Shape): ImageChange[] {
  return changeMix(SINGLE_STEP_RUNS[shape.name], mixSeed("pipeline-200"));
}

/**
 * P6 (ruling R24): a run's status sequence from what was observed, merged in
 * time order (`at`; ties keep their order), starting from `initial`, with
 * consecutive repeats collapsed. Its length minus 1 is the status changes.
 */
export function statusSequence(
  initial: string,
  observations: readonly { at: number; status: string }[],
): string[] {
  const sequence = [initial];
  const ordered = observations
    .map((o, i) => ({ ...o, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  for (const { status } of ordered) {
    if (status !== sequence[sequence.length - 1]) sequence.push(status);
  }
  return sequence;
}

/**
 * P6 (ruling R24): the run status a message on the run's own channel
 * (`run:<id>:events`) announces, or undefined when it announces none.
 *
 * Only the diff worker's `run.completed` counts: it carries the new status at
 * the top level and is published once per status change a step's commit
 * makes. Ignored:
 * - `run.checkpoint_diffed`, published after every step's commit, which names
 *   the step's verdict but no run status;
 * - the api's `/complete` and `/abort` `run.completed`, whose status is nested
 *   in `payload`: it is what the api read, not a diff result;
 * - anything else, or a message that is not a JSON object.
 */
export function runCompletedStatus(message: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { type, status } = parsed as { type?: unknown; status?: unknown };
  return type === "run.completed" && typeof status === "string"
    ? status
    : undefined;
}

/** A status sequence for a note, at most `max` statuses before the ellipsis. */
export function formatSequence(sequence: readonly string[], max = 12): string {
  if (sequence.length <= max) return sequence.join("→");
  return `${sequence.slice(0, max - 1).join("→")}→…→${sequence[sequence.length - 1]} (${sequence.length} statuses)`;
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
 * Result latencies (ms): result time minus upload time, capped at `timeoutMs`
 * (ruling R22). A step whose result came later than that, or never, counts at
 * `timeoutMs`: a failed sample, never a dropped one. `capped` counts them.
 */
export function latencySamples(
  steps: readonly { uploadedAt: number; resultAt?: number }[],
  timeoutMs: number,
): { samples: number[]; capped: number } {
  let capped = 0;
  const samples = steps.map((step) => {
    const latency =
      step.resultAt === undefined ? Infinity : step.resultAt - step.uploadedAt;
    if (latency > timeoutMs) {
      capped += 1;
      return timeoutMs;
    }
    return latency;
  });
  return { samples, capped };
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
