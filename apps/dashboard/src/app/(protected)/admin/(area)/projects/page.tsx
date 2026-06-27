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
      <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-white">
          Not authorized
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
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
    <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-medium text-zinc-950 dark:text-white">
            Projects
          </h3>
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-100 px-1.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
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
              className="block rounded-xl outline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-brand"
              data-testid={`admin-project-card-${p.id}`}
            >
              <Card className="h-full transition-[border-color,box-shadow,transform] duration-150 hover:border-zinc-300 hover:-translate-y-0.5 hover:shadow-md dark:hover:border-zinc-700 dark:hover:shadow-zinc-900/50">
                <h2 className="text-lg font-semibold text-zinc-950 dark:text-white">
                  {p.name}
                </h2>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Main branch:{" "}
                  <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
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
