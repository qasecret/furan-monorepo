import { redirect } from "next/navigation";

/**
 * The standalone Runs list was retired in Phase C / C2 (ADR-045): the
 * builds-list is the canonical project home and the per-build batch page
 * (`/builds/[buildId]`) is the test-review surface. This route now
 * redirects so stale `/runs` bookmarks and links degrade gracefully.
 * NOTE: the diff-viewer lives under `runs/[runId]/...` — a SEPARATE route
 * subtree — and is unaffected by this redirect.
 */
export default async function ProjectRunsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/builds`);
}
