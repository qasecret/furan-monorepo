import type { ReactNode } from "react";

import { ProjectTabs } from "./_components/project-tabs";

/**
 * Project-scoped layout with a Builds / Runs / Settings tab strip.
 * Builds is the default landing tab (see /projects/[id]/page.tsx redirect).
 *
 * Active-state highlighting lives in `ProjectTabs` (a client island that
 * uses usePathname); this layout itself stays server-rendered.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <div className="space-y-4">
      <ProjectTabs projectId={projectId} />
      {children}
    </div>
  );
}
