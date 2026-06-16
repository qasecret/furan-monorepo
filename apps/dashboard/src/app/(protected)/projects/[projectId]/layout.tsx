import type { ReactNode } from "react";

import { ProjectHeader } from "./_components/project-header";

import { getProject } from "@/lib/get-project";

/**
 * Project-scoped layout. Owns the project's section header — the project name
 * as identity plus the Builds / Runs / Variations / Settings tab strip (see
 * `<ProjectHeader>`). The header hides itself on the full-screen diff viewer.
 *
 * The name is fetched here once via `getProject` (React-`cache()`d, so it
 * shares the request with each tab page's own gating fetch). On a failed
 * lookup — 403/404 — the header is skipped and the child page renders its own
 * error card.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { data } = await getProject(projectId);
  return (
    <div className="space-y-4">
      {data?.name ? (
        <ProjectHeader projectId={projectId} name={data.name} />
      ) : null}
      {children}
    </div>
  );
}
