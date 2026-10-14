import { loopQuery, type ReviewContext } from "@/lib/review-context";

/**
 * Route to the diff viewer for a checkpoint of a run, keeping the review
 * context (spec §3.3): `/projects/:p/runs/:r/checkpoints/:c?status=...&browser=...`.
 *
 * With no checkpoint the viewer resolves `_first` itself (the run's first
 * checkpoint). Only the status and the environment facets travel to the
 * viewer; branch, search and props belong to Batches and are not carried.
 */
export function diffViewerHref(
  projectId: string,
  runId: string,
  checkpointId?: string,
  ctx?: Partial<ReviewContext>,
): string {
  const checkpoint = checkpointId ? encodeURIComponent(checkpointId) : "_first";
  return `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/checkpoints/${checkpoint}${loopQuery(ctx)}`;
}
