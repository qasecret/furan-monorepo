import type { ReactNode } from "react";

import { RecordRecentProject } from "./_components/record-recent-project";

import { getProject } from "@/lib/get-project";

/**
 * Project-scoped layout. Fetches the project name once via `getProject`
 * (React-`cache()`d, so it shares the request with each tab page's own gating
 * fetch) and mounts the headless `RecordRecentProject` side-effect so the
 * command palette's Recent group stays current. On a failed lookup — 403/404 —
 * the side-effect is skipped and the child page renders its own error card.
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
    <div className="flex min-h-0 flex-1 flex-col">
      {data?.name ? (
        <RecordRecentProject projectId={projectId} name={data.name} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
