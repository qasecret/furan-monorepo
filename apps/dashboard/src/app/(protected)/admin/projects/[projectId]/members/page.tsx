import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ProjectMembersTable } from "./_components/project-members-table";

import { Forbidden } from "@/components/ui/forbidden";
import { PageContainer } from "@/components/ui/page-container";
import { apiGet } from "@/lib/api-client";
import { isAtLeastAdmin, type ViewerRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Members",
};

interface Me {
  id: string;
  role: ViewerRole;
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
    !isAtLeastAdmin(me.data.role)
  ) {
    return (
      <PageContainer>
        <Forbidden
          title="403 — admin only"
          description="You need the admin role to manage project members."
        />
      </PageContainer>
    );
  }

  const project = await apiGet<Project>(`/projects/${projectId}`);
  if (project.status === 404 || !project.data) {
    notFound();
  }

  return (
    <PageContainer>
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-fg">Members</h1>
        <p className="text-sm text-fg-secondary">
          Project: <span className="font-medium">{project.data.name}</span>
        </p>
        <ProjectMembersTable projectId={projectId} />
      </div>
    </PageContainer>
  );
}
