import type { Metadata } from "next";
import Link from "next/link";

import { CreateProjectDialog } from "./_components/create-project-dialog";
import { EmptyProjectsCta } from "./_components/empty-projects-cta";

import { PageTour } from "@/components/tour/page-tour";
import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "Projects" };

const PROJECTS_PAGE_TOUR = [
  {
    target: "#projects-list",
    title: "Projects",
    content:
      "Each project owns its own builds, test variations, and baselines. Click any card to drill in.",
    placement: "bottom" as const,
  },
  {
    target: "#projects-create",
    title: "Create a project",
    content:
      "Admins can spin up a new project here. Each project gets its own PAT for SDK auth.",
    placement: "left" as const,
  },
];

export const dynamic = "force-dynamic";

interface Project {
  id: string;
  name: string;
  mainBranchName: string;
}

interface Me {
  id: string;
  role: "admin" | "editor" | "guest";
}

export default async function ProjectsPage() {
  const [projectsRes, meRes] = await Promise.all([
    apiGet<Project[]>("/projects"),
    apiGet<Me>("/users/me"),
  ]);
  if (projectsRes.status === 401 || projectsRes.status === 403) {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
          Not authorized
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your session may have expired. Try signing in again.
        </p>
      </Card>
    );
  }
  const projects = projectsRes.data ?? [];
  const role: Me["role"] = meRes.data?.role ?? "guest";

  if (projects.length === 0) {
    return <EmptyProjectsCta role={role} />;
  }

  return (
    <div className="space-y-4">
      <PageTour pageId="projects-index" steps={PROJECTS_PAGE_TOUR} />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
          Projects
        </h1>
        {role === "admin" && (
          <div id="projects-create">
            <CreateProjectDialog />
          </div>
        )}
      </div>
      <div
        id="projects-list"
        className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
      >
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="block rounded-xl outline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-brand"
            data-testid={`project-card-${p.id}`}
          >
            <Card className="h-full hover:border-zinc-300 transition-colors dark:hover:border-zinc-700">
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
  );
}
