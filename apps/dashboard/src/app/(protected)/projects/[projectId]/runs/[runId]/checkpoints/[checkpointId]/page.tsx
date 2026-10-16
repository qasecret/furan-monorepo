import { CheckpointViewer } from "./_components/checkpoint-viewer";

import { canReviewRole, getViewer } from "@/lib/get-viewer";
// The pure module, never the `review-url` barrel: this is a server component,
// and the barrel also re-exports the client hook.
import { parseReviewContext } from "@/lib/review-context";

export const dynamic = "force-dynamic";

/**
 * /projects/[projectId]/runs/[runId]/checkpoints/[checkpointId] — the diff
 * viewer on one step.
 *
 * A Server Component, so that whether the viewer may decide is the server's
 * answer for the request's role (R14), as on the batch page: a guest's first
 * paint has no decision buttons, with no flicker (the client's command role
 * is "guest" until it hydrates). The review context rides in the URL (spec
 * §3.3); the viewer gets it as one prop, parsed and validated here, so it is
 * never read from component state. The user's id keys their viewer
 * preferences; the same `/users/me` call answers it and the role.
 */
export default async function CheckpointPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; runId: string; checkpointId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, runId, checkpointId }, query, viewer] = await Promise.all(
    [params, searchParams, getViewer()],
  );
  return (
    <CheckpointViewer
      projectId={projectId}
      runId={runId}
      checkpointId={checkpointId}
      reviewContext={parseReviewContext(query)}
      canReview={canReviewRole(viewer.role)}
      userId={viewer.id}
    />
  );
}
