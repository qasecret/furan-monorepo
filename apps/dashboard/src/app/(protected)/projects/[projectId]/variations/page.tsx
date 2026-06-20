import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { MergeBaselinesPanel } from "./_components/merge-baselines-panel";
import { VariationsList } from "./_components/variations-list";

import { PageTour } from "@/components/tour/page-tour";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { getProject } from "@/lib/get-project";
import { getViewerRole } from "@/lib/get-viewer";

export const metadata: Metadata = { title: "Variations" };

const VARIATIONS_PAGE_TOUR = [
  {
    target: "#variations-merge-panel",
    title: "Merge baselines across branches",
    content:
      "Promote approved baselines from a feature branch onto your main branch. Variations that already match on both sides are skipped.",
    placement: "top" as const,
  },
];

export const dynamic = "force-dynamic";

/**
 * /projects/[projectId]/variations — variation-management surface for the
 * project. Initial scope ships the cross-branch baseline merge panel
 * (spec 2026-05-24-cross-branch-baseline-merge-design.md). A full
 * variation list/filter UI is planned but not in this PR — the existing
 * /variations/[variationId] detail page is the per-variation drilldown.
 *
 * Server-Component fetches the project so non-members see a 404 instead
 * of a spinning client-side query; the panel itself is a client island
 * (cmdk-style) so it can use the typed tRPC client.
 */
export default async function ProjectVariationsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = await getProject(projectId);
  if (project.status === 401) {
    redirect("/login");
  }
  if (project.status === 404) {
    notFound();
  }
  if (project.status === 403 || !project.data) {
    return (
      <PageContainer>
        <Card>
          <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
            403 — not a project member
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            You need to be added to this project to view its variations.
          </p>
        </Card>
      </PageContainer>
    );
  }

  const userRole = await getViewerRole();

  return (
    <PageContainer>
      <div className="space-y-4">
        <PageTour pageId="variations-index" steps={VARIATIONS_PAGE_TOUR} />
        <div id="variations-merge-panel">
          <MergeBaselinesPanel projectId={projectId} userRole={userRole} />
        </div>
        <VariationsList projectId={projectId} />
      </div>
    </PageContainer>
  );
}
