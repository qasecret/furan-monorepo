import type { ReactNode } from "react";

import { BuildsListPanel } from "./_components/builds-list-panel";

import { apiGet } from "@/lib/api-client";
import { getProject } from "@/lib/get-project";

interface ProjectApiItem {
  id: string;
  name: string;
}

/**
 * List-detail layout for the Builds tab: a persistent builds panel beside the
 * routed content (the /builds placeholder or a /builds/[buildId] batch). Wraps
 * only the /builds/* subtree, so it nests under the project header/tabs without
 * affecting Variations/Settings. The project list (for the panel's switcher) is
 * fetched server-side here, mirroring the projects index page (there is no tRPC
 * projects.list). Panel is stacked on mobile, sticky beside content on md+.
 */
export default async function BuildsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await getProject(projectId);
  if (project.status !== 200 || !project.data) {
    // Non-member / not-found: let the routed page render its own 403/redirect
    // without a dead panel beside it.
    return <>{children}</>;
  }

  const res = await apiGet<ProjectApiItem[]>("/projects");
  const projects = (res.data ?? []).map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <aside className="w-full shrink-0 md:sticky md:top-6 md:w-72 md:self-start">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
          <BuildsListPanel projectId={projectId} projects={projects} />
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
