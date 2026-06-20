import type { Metadata } from "next";
import Link from "next/link";

import { CreateProjectDialog } from "@/app/(protected)/projects/_components/create-project-dialog";
import { EmptyProjectsCta } from "@/app/(protected)/projects/_components/empty-projects-cta";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { apiGet } from "@/lib/api-client";
import { getViewerRole } from "@/lib/get-viewer";

export const metadata: Metadata = { title: "Projects" };

export const dynamic = "force-dynamic";

interface Project {
  id: string;
  name: string;
  mainBranchName: string;
}

/**
 * Admin-area all-projects grid (U8). Mirrors the workspace `/projects` grid but
 * each card drills into the per-project admin surface (`/admin/projects/<id>/
 * members`) rather than the project dashboard. Admins are the only ones who
 * create + assign projects, so the Create dialog lives here alongside the list.
 *
 * The (area)/layout.tsx renders the 403 Card for non-admins, but Next.js still
 * executes this RSC — so re-check the (request-cached, free) role and bail
 * BEFORE the /projects fetch, matching the members page's ordering.
 */
export default async function AdminProjectsPage() {
  if ((await getViewerRole()) !== "admin") return null;

  const projectsRes = await apiGet<Project[]>("/projects");
  if (projectsRes.status === 401 || projectsRes.status === 403) {
    return (
      <PageContainer>
        <Card>
          <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
            Not authorized
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Your session may have expired. Try signing in again.
          </p>
        </Card>
      </PageContainer>
    );
  }
  const projects = projectsRes.data ?? [];

  return (
    <PageContainer>
      <div className="space-y-4">
        {projects.length === 0 ? (
          // The (area) layout guarantees the viewer is an admin here, so the
          // admin "create your first project" variant always renders.
          <EmptyProjectsCta role="admin" />
        ) : (
          <>
            <PageHeader title="Projects" actions={<CreateProjectDialog />} />
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
          </>
        )}
      </div>
    </PageContainer>
  );
}
