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
  baselineKey: string;
  candidateKey: string;
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
