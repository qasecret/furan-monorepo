import type { ReactNode } from "react";

import { BuildsListPanel } from "./_components/builds-list-panel";

import { getProject } from "@/lib/get-project";

/**
 * List-detail layout for the Builds tab: a persistent builds panel beside the
 * routed content (the /builds placeholder or a /builds/[buildId] batch). Wraps
 * only the /builds/* subtree, so it nests under the project header/tabs without
 * affecting Variations/Settings. Panel is stacked on mobile, sticky beside
 * content on md+.
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:flex-row md:p-6">
      <aside className="flex min-h-0 shrink-0 flex-col md:w-72">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <BuildsListPanel projectId={projectId} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
