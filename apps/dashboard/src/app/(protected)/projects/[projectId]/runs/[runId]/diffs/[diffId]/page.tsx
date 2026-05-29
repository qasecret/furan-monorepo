import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Legacy /diffs/[diffId] route — 302 to the new canonical checkpoint URL.
 * The diffId is the screenshot/checkpoint id, so we forward it directly.
 */
export default async function LegacyDiffPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string; diffId: string }>;
}) {
  const { projectId, runId, diffId } = await params;
  redirect(`/projects/${projectId}/runs/${runId}/checkpoints/${diffId}`);
}
