import { type RunStatus, runStatusSchema } from "@furan/shared-types";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { RunsTable } from "./_components/runs-table";

import { PageTour } from "@/components/tour/page-tour";
import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "Runs" };

const RUNS_PAGE_TOUR = [
  {
    target: "#runs-filters",
    title: "Filter runs",
    content:
      "Slice by branch, status, browser, viewport, OS, device, or custom tags. URL params reflect the filter so links are shareable.",
    placement: "bottom" as const,
  },
  {
    target: '[data-testid="runs-table"]',
    title: "Run history",
    content:
      "Each row is one test run from the SDK. Click into a row to see its baseline + diff regions in the viewer.",
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
 * Next.js' `searchParams` may give a single param as `string` or — when
 * the same key appears multiple times in the URL (e.g.
 * `?status=unresolved&status=failed`) — as `string[]`. Normalize both
 * shapes into a single array so the rest of this page treats the
 * status filter as multi-valued per spec §3.5.
 */
function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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
  searchParams?: Promise<{
    branch?: string;
    status?: string | string[];
    browser?: string;
    viewport?: string;
    os?: string;
    device?: string;
    customTags?: string;
  }>;
}) {
  const { projectId } = await params;
  const sp: {
    branch?: string;
    status?: string | string[];
    browser?: string;
    viewport?: string;
    os?: string;
    device?: string;
    customTags?: string;
  } = (await searchParams) ?? {};
  // Narrow each raw URL `status` value through the typed enum; unknown
  // values (e.g. stale links from before the enum migration) silently
  // drop out rather than 500ing. Deduplicate to keep the filter set
  // canonical.
  const rawStatuses = asArray(sp.status);
  const parsed: RunStatus[] = [];
  const seen = new Set<RunStatus>();
  for (const raw of rawStatuses) {
    const r = runStatusSchema.safeParse(raw);
    if (r.success && !seen.has(r.data)) {
      seen.add(r.data);
      parsed.push(r.data);
    }
  }
  const initialStatus = parsed.length > 0 ? parsed : undefined;

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
        <h1 className="text-xl font-semibold text-white">
          403 — not a project member
        </h1>
        <p className="text-sm text-zinc-400">
          You need to be added to this project to view its runs.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <PageTour pageId="runs-index" steps={RUNS_PAGE_TOUR} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Runs
        </h1>
        <p className="text-sm text-zinc-400">
          Project:{" "}
          <span className="font-medium text-zinc-200">{project.data.name}</span>
        </p>
      </div>
      <RunsTable
        projectId={projectId}
        initialBranch={sp.branch}
        initialStatus={initialStatus}
        initialDevice={{
          browser: sp.browser,
          viewport: sp.viewport,
          os: sp.os,
          device: sp.device,
          customTags: sp.customTags,
        }}
      />
    </div>
  );
}
