export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface CaptureJob {
  runId: string;
  projectId: string;
  buildId: string;
  testVariationId: string;
  url: string;
  /**
   * v0.4 single-viewport field — kept for backwards compatibility. If
   * `viewports` is set, this is ignored.
   */
  viewport?: Viewport;
  /**
   * v0.5+: optional array of viewports to capture in a single job. If
   * omitted, the capture-worker falls back to [`viewport`] when set, or to
   * a default of `[{ width: 1280, height: 720 }]`.
   */
  viewports?: Viewport[];
  browser: "chromium" | "firefox" | "webkit";
}

export interface DiffJob {
  runId: string;
  projectId: string;
  /**
   * Per-step diff pipeline: the one step (screenshot) this job diffs, and the
   * step's version (`screenshots.diff_generation`) it was queued at. A job
   * whose version no longer matches the step's is stale and writes nothing.
   * Both are absent on an old whole-run job, which the worker splits into
   * per-step jobs. The job's id is `diffJobId(screenshotId, generation)`.
   */
  screenshotId?: string;
  generation?: number;
  // Phase 2: the worker derives baseline + candidate storage keys from the
  // screenshots table via `resolveBaseline`; these legacy fields remain
  // optional for callers that already populate them (handler ignores them).
  baselineKey?: string;
  candidateKey?: string;
  // Optional PR parent base branch used as the second tier in baseline
  // resolution (see `resolveBaseline` in @furan/db).
  parentPrBaseBranch?: string | null;
}

/**
 * The BullMQ job id of one step at one version. A version is never reused, so
 * queueing the same one twice (a reconciler re-add while the job is still
 * queued) is a no-op, and BullMQ's retention of completed jobs can never swallow
 * a real re-diff.
 *
 * It joins with `-g`, not `:`: BullMQ throws on a `:` in a custom job id.
 */
export function diffJobId(screenshotId: string, generation: number): string {
  return `${screenshotId}-g${generation}`;
}

export interface WebhookJob {
  projectId: string;
  webhookId: string;
  event: string;
  payload: unknown;
}

/**
 * Nightly per-project TTL sweep job (Phase 5 D3 / spec §9 GA-row metric
 * "`projects.retention_days` enforced nightly"). Enqueued by the cron
 * scheduler at startup (`server.ts`) and optionally by the
 * `cli/retention.ts` helper for one-shot or per-project sweeps.
 */
export interface RetentionJob {
  /**
   * When omitted/empty, the handler sweeps every project with
   * `retentionDays > 0`. When set, restricts the sweep to the listed
   * project ids (still respecting each project's own `retentionDays`
   * guard — projects with `retentionDays <= 0` are skipped).
   */
  projectIds?: string[];
  /**
   * When true, the handler logs the would-be deletions per project but
   * never deletes any rows or storage objects. Used by the CLI for
   * pre-flight inspection.
   */
  dryRun?: boolean;
}

export type JobMap = {
  capture: CaptureJob;
  diff: DiffJob;
  webhook: WebhookJob;
  retention: RetentionJob;
};
export type JobName = keyof JobMap;
