import { notFound, redirect } from "next/navigation";

import { BuildsTable } from "./_components/builds-table";

import { PageTour } from "@/components/tour/page-tour";
import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

const BUILDS_PAGE_TOUR = [
  {
    target: "#builds-table",
    title: "Build list",
    content:
      "Every CI run that calls the SDK creates a build here. If you see no builds, point your SDK at this server using a project token.",
    placement: "top" as const,
  },
];

export const dynamic = "force-dynamic";

interface Project {
  id: string;
  name: string;
  mainBranchName: string;
}

/**
 * /projects/[projectId]/builds — the project's default landing tab.
 *
 * Server Component probes the project so non-members get a 404 instead of
 * a spinning client-side query. The table itself is a client island that
 * owns cursor pagination + expand-row + property-filter state.
 */
export default async function ProjectBuildsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await apiGet<Project>(`/projects/${projectId}`);
  if (project.status === 401) redirect("/login");
  if (project.status === 404) notFound();
  if (project.status === 403 || !project.data) {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-white">
          403 — not a project member
        </h1>
        <p className="text-sm text-zinc-400">
          You need to be added to this project to view its builds.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <PageTour pageId="builds-index" steps={BUILDS_PAGE_TOUR} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Builds
        </h1>
        <p className="text-sm text-zinc-400">
          Project:{" "}
          <span className="font-medium text-zinc-200">{project.data.name}</span>
        </p>
      </div>
      <div id="builds-table">
        <BuildsTable projectId={projectId} />
      </div>
    </div>
  );
}
