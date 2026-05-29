import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Bare /runs/[runId] redirect: forward to the checkpoint viewer with the
 * sentinel `_first` so DiffViewer fetches the first checkpoint and replaces
 * the URL with the canonical /checkpoints/:checkpointId path.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>;
}) {
  const { projectId, runId } = await params;
  redirect(`/projects/${projectId}/runs/${runId}/checkpoints/_first`);
}
