import { notFound } from "next/navigation";

import { ProjectMembersTable } from "./_components/project-members-table";

import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

interface Me {
  id: string;
  role: "admin" | "editor" | "guest";
}

interface Project {
  id: string;
  name: string;
}

export default async function ProjectMembersPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const me = await apiGet<Me>("/users/me");
  if (
    me.status === 401 ||
    me.status === 403 ||
    !me.data ||
    me.data.role !== "admin"
  ) {
    return (
      <Card>
        <h1 className="text-xl font-bold">403 — admin only</h1>
        <p className="text-sm text-neutral-600">
          You need the admin role to manage project members.
        </p>
      </Card>
    );
  }

  const project = await apiGet<Project>(`/projects/${projectId}`);
  if (project.status === 404 || !project.data) {
    notFound();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Members</h1>
      <p className="text-sm text-neutral-600">
        Project: <span className="font-medium">{project.data.name}</span>
      </p>
      <ProjectMembersTable projectId={projectId} />
    </div>
  );
}
