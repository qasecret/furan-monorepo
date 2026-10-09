import type { Metadata } from "next";
import Link from "next/link";

import { CreateProjectDialog } from "@/app/(protected)/projects/_components/create-project-dialog";
import { EmptyProjectsCta } from "@/app/(protected)/projects/_components/empty-projects-cta";
import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";
import { getViewerRole, isAtLeastAdmin } from "@/lib/get-viewer";

export const metadata: Metadata = { title: "Projects" };

export const dynamic = "force-dynamic";

interface Project {
  id: string;
  name: string;
  mainBranchName: string;
}

export default async function AdminProjectsPage() {
  if (!isAtLeastAdmin(await getViewerRole())) return null;

  const projectsRes = await apiGet<Project[]>("/projects");
  if (projectsRes.status === 401 || projectsRes.status === 403) {
    return (
      <div className="rounded-lg bg-raised p-6 shadow-raised">
        <h2 className="text-lg font-semibold text-fg">Not authorized</h2>
        <p className="text-sm text-fg-secondary">
          Your session may have expired. Try signing in again.
        </p>
      </div>
    );
  }
  const projects = projectsRes.data ?? [];

  if (projects.length === 0) {
    return <EmptyProjectsCta role="admin" />;
  }

  return (
    <div className="rounded-lg bg-raised shadow-raised">
      <div className="flex items-center justify-between border-b border-edge px-6 py-4">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-medium text-fg">Projects</h3>
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-hover px-1.5 text-xs font-medium tabular-nums text-fg-secondary">
            {projects.length}
          </span>
        </div>
        <CreateProjectDialog />
      </div>
      <div className="p-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/admin/projects/${p.id}/members`}
              className="block rounded-lg focus-ring"
              data-testid={`admin-project-card-${p.id}`}
            >
              <Card className="h-full transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-overlay">
                <h2 className="text-lg font-semibold text-fg">{p.name}</h2>
                <p className="text-sm text-fg-secondary">
                  Main branch:{" "}
                  <code className="font-mono text-xs text-fg-secondary">
                    {p.mainBranchName}
                  </code>
                </p>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
