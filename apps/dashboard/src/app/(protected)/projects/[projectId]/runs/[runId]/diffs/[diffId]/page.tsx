import { redirect } from "next/navigation";

import { apiGet } from "@/lib/api-client";
import { diffViewerHref } from "@/lib/diff-viewer-href";
import { parseReviewContext } from "@/lib/review-context";

export const dynamic = "force-dynamic";

/** `GET /trpc/runs.listCheckpoints` as the API answers it (no transformer). */
interface ListCheckpointsResponse {
  result?: { data?: { items?: unknown } };
}

/**
 * Whether `stepId` is one of `runId`'s steps. Any failure (no session, no
 * access, a network error, an answer of another shape) is "no": the caller
 * then lands on the run's first step, which the viewer always can show.
 */
async function isStepOfRun(runId: string, stepId: string): Promise<boolean> {
  try {
    const input = encodeURIComponent(JSON.stringify({ runId }));
    const res = await apiGet<ListCheckpointsResponse>(
      `/trpc/runs.listCheckpoints?input=${input}`,
    );
    const items = res.data?.result?.data?.items;
    return (
      Array.isArray(items) &&
      items.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          (item as { id?: unknown }).id === stepId,
      )
    );
  } catch (error) {
    // Swallowed on purpose: a failed lookup must never break an old link; the
    // viewer opens the run's first step instead. It is logged so that a
    // lookup that fails every time can be traced. Only the run id and the
    // error's message are logged, never the session cookie or a token.
    console.warn(
      `legacy diff link: could not list the steps of run ${runId}; opening its first step (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return false;
  }
}

/**
 * Legacy /diffs/[diffId] route: redirects to the canonical checkpoint URL.
 *
 * Old links put the screenshot (step) id here, but variation history used to
 * put the RUN id. A run id opened as a step renders "Step —", so the id is
 * only forwarded when it is a step of this run; otherwise the viewer opens the
 * run's first step (`_first`). The review context (status and environment
 * facets) travels on; anything else in the query is dropped.
 */
export default async function LegacyDiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; runId: string; diffId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, runId, diffId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const step = (await isStepOfRun(runId, diffId)) ? diffId : undefined;
  // `redirect` throws to end the render, so it stays outside any try/catch.
  redirect(diffViewerHref(projectId, runId, step, parseReviewContext(query)));
}
