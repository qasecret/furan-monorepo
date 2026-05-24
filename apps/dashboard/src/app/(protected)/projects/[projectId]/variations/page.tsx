import { notFound, redirect } from "next/navigation";

import { MergeBaselinesPanel } from "./_components/merge-baselines-panel";

import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

interface Project {
  id: string;
  name: string;
}

interface Me {
  role: "admin" | "editor" | "guest";
}

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
          You need to be added to this project to view its variations.
        </p>
      </Card>
    );
  }

  const me = await apiGet<Me>("/users/me").catch(() => ({
    status: 0,
    data: null as Me | null,
  }));
  const userRole: Me["role"] = me.data?.role ?? "guest";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Variations
        </h1>
        <p className="text-sm text-zinc-400">
          Project:{" "}
          <span className="font-medium text-zinc-200">{project.data.name}</span>
        </p>
      </div>
      <MergeBaselinesPanel projectId={projectId} userRole={userRole} />
    </div>
  );
}
