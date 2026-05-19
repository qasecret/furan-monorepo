import { runStatusSchema } from "@furan/shared-types";
import { notFound, redirect } from "next/navigation";

import { RunsTable } from "./_components/runs-table";

import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

interface Project {
  id: string;
  name: string;
  mainBranchName: string;
}

/**
 * /projects/[projectId]/runs — cursor-paginated index of test runs with
 * branch + status filters. Server Component probes the project so non-
 * members see a 404 instead of a spinning client-side query. The table
 * itself is a client island so we can use the typed tRPC hook and
 * incremental cursor pagination without re-rendering the whole page.
 */
export default async function ProjectRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ branch?: string; status?: string }>;
}) {
  const { projectId } = await params;
  const sp: { branch?: string; status?: string } = (await searchParams) ?? {};
  // Narrow the raw URL `status` param to the typed enum; an unknown value
  // (e.g. a stale link from before the enum migration) silently falls
  // through to "All statuses" rather than 500ing.
  const parsedStatus = sp.status
    ? runStatusSchema.safeParse(sp.status)
    : undefined;
  const initialStatus = parsedStatus?.success ? parsedStatus.data : undefined;

  const project = await apiGet<Project>(`/projects/${projectId}`);
  if (project.status === 401) {
    redirect("/login");
  }
  if (project.status === 404) {
    notFound();
  }
  if (project.status === 403 || !project.data) {
    return (
      <Card>
        <h1 className="text-xl font-bold">403 — not a project member</h1>
        <p className="text-sm text-neutral-600">
          You need to be added to this project to view its runs.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-bold">Runs</h1>
        <p className="text-sm text-neutral-600">
          Project: <span className="font-medium">{project.data.name}</span>
        </p>
      </div>
      <RunsTable
        projectId={projectId}
        initialBranch={sp.branch}
        initialStatus={initialStatus}
      />
    </div>
  );
}
