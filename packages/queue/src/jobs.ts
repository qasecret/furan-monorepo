export interface CaptureJob {
  runId: string;
  projectId: string;
  buildId: string;
  testVariationId: string;
  url: string;
  viewport: { width: number; height: number };
  browser: "chromium" | "firefox" | "webkit";
}

export interface DiffJob {
  runId: string;
  projectId: string;
  // Phase 2: the worker derives baseline + candidate storage keys from the
  // screenshots table via `resolveBaseline`; these legacy fields remain
  // optional for callers that already populate them (handler ignores them).
  baselineKey?: string;
  candidateKey?: string;
  // Optional PR parent base branch used as the second tier in baseline
  // resolution (see `resolveBaseline` in @furan/db).
  parentPrBaseBranch?: string | null;
}

export interface WebhookJob {
  projectId: string;
  webhookId: string;
  event: string;
  payload: unknown;
}

export type JobMap = {
  capture: CaptureJob;
  diff: DiffJob;
  webhook: WebhookJob;
};
export type JobName = keyof JobMap;
