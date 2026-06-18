import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { BatchPage } from "./_components/batch-page";

import { Card } from "@/components/ui/card";
import { getProject } from "@/lib/get-project";
import { canReviewRole, getViewerRole } from "@/lib/get-viewer";

export const metadata: Metadata = { title: "Build details" };
export const dynamic = "force-dynamic";

/**
 * /projects/[projectId]/builds/[buildId] — the batch-detail page.
 *
 * Server Component probes the project so non-members get a 404 instead of a
 * spinning client-side query. The `BatchPage` client island owns all query
 * state (build header + run cards + pagination).
 */
export default async function BuildDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; buildId: string }>;
}) {
  const { projectId, buildId } = await params;

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

  const canReview = canReviewRole(await getViewerRole());

  return (
    <BatchPage
      projectId={projectId}
      buildId={buildId}
      projectName={project.data.name}
      canReview={canReview}
    />
  );
}
