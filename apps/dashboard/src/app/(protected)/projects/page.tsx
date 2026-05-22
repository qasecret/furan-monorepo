import Link from "next/link";

import { CreateProjectDialog } from "./_components/create-project-dialog";
import { EmptyProjectsCta } from "./_components/empty-projects-cta";

import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

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
    return <p>Not authorized.</p>;
  }
  const projects = projectsRes.data ?? [];
  const role: Me["role"] = meRes.data?.role ?? "guest";

  if (projects.length === 0) {
    return <EmptyProjectsCta role={role} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        {role === "admin" && <CreateProjectDialog />}
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="block rounded-lg outline-offset-2 transition hover:shadow-md focus-visible:outline-2"
            data-testid={`project-card-${p.id}`}
          >
            <Card>
              <h2 className="text-lg font-semibold">{p.name}</h2>
              <p className="text-sm text-neutral-600">
                Main branch: {p.mainBranchName}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
