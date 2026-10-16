import type { ViewerMode } from "@/components/diff-viewer/comparison-modes";
import { loopQuery, type ReviewContext } from "@/lib/review-context";

/**
 * Route to the diff viewer for a checkpoint of a run, keeping the review
 * context (spec §3.3): `/projects/:p/runs/:r/checkpoints/:c?status=...&browser=...`.
 *
 * With no checkpoint the viewer resolves `_first` itself (the run's first
 * checkpoint). Only the status and the environment facets travel to the
 * viewer; branch, search and props belong to Batches and are not carried.
 *
 * `view` is the comparison mode (spec §6.3), the link's last param. Only the
 * links the viewer makes carry it (its steps, J / K, the done cards, the
 * newer capture): a link from another page opens in the reviewer's saved
 * preference.
 */
export function diffViewerHref(
  projectId: string,
  runId: string,
  checkpointId?: string,
  ctx?: Partial<ReviewContext>,
  view?: ViewerMode | null,
): string {
  const checkpoint = checkpointId ? encodeURIComponent(checkpointId) : "_first";
  const query = loopQuery(ctx);
  const withView = view ? `${query}${query ? "&" : "?"}view=${view}` : query;
  return `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/checkpoints/${checkpoint}${withView}`;
}
