import { redirect } from "next/navigation";

import { diffViewerHref } from "@/lib/diff-viewer-href";
import { parseReviewContext } from "@/lib/review-context";

export const dynamic = "force-dynamic";

/**
 * Bare /runs/[runId] redirect: forward to the checkpoint viewer with the
 * sentinel `_first` so DiffViewer fetches the first checkpoint and replaces
 * the URL with the canonical /checkpoints/:checkpointId path. The review
 * context (status and environment facets) travels on; anything else in the
 * query is dropped.
 */
export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, runId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  redirect(
    diffViewerHref(projectId, runId, undefined, parseReviewContext(query)),
  );
}
