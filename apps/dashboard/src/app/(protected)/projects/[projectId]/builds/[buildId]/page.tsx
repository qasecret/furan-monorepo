import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { BatchPage } from "./_components/batch-page";

import { Card } from "@/components/ui/card";
import { getProject } from "@/lib/get-project";
import { canReviewRole, getViewerRole } from "@/lib/get-viewer";
// The pure module, never the `review-url` barrel: this is a server component,
// and the barrel also re-exports the client hook.
import { parseReviewContext } from "@/lib/review-context";

export const metadata: Metadata = { title: "Build details" };
export const dynamic = "force-dynamic";

/**
 * /projects/[projectId]/builds/[buildId] — the batch-detail page.
 *
 * Server Component probes the project so non-members get a 404 instead of a
 * spinning client-side query. The `BatchPage` client island owns all query
 * state (build header + run cards + pagination). It is handed the review
 * context of the request (spec §3.3): the status chip (Needs review when
 * absent or invalid) and the environment facets. Bad input is dropped
 * silently; it never errors the page.
 */
export default async function BuildDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; buildId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, buildId } = await params;
  const context = parseReviewContext(await searchParams);

  const project = await getProject(projectId);
  if (project.status === 401) redirect("/login");
  if (project.status === 404) notFound();
  if (project.status === 403 || !project.data) {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-fg">
          403 — not a project member
        </h1>
        <p className="text-sm text-fg-secondary">
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
      canReview={canReview}
      context={context}
    />
  );
}
