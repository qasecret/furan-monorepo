import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getProject } from "@/lib/get-project";

export const metadata: Metadata = { title: "Builds" };
export const dynamic = "force-dynamic";

/**
 * /projects/[projectId]/builds — the Builds tab index. The builds list now
 * lives in the persistent panel (see builds/layout.tsx); this routed pane
 * prompts the reviewer to pick one. Keeps the same membership gating the
 * batch page uses so non-members get a 404/403 rather than a bare panel.
 */
export default async function ProjectBuildsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await getProject(projectId);
  if (project.status === 401) redirect("/login");
  if (project.status === 404) notFound();
  if (project.status === 403 || !project.data) {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
          403 — not a project member
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          You need to be added to this project to view its builds.
        </p>
      </Card>
    );
  }

  return (
    <EmptyState
      title="Select a build to review"
      description="Pick a build from the list to see its tests."
    />
  );
}
