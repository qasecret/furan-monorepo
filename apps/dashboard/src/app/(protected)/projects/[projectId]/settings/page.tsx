import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ProjectSettingsForm } from "./_components/project-settings-form";

import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { apiGet } from "@/lib/api-client";
import { getProject } from "@/lib/get-project";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

interface Me {
  id: string;
  role: "owner" | "admin" | "editor" | "guest";
}

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const me = await apiGet<Me>("/users/me");
  if (me.status === 401 || !me.data) {
    redirect("/login");
  }

  const project = await getProject(projectId);
  if (project.status === 404) {
    notFound();
  }
  if (project.status === 403 || !project.data) {
    return (
      <PageContainer>
        <Card>
          <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
            403 — not a project member
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            You need to be added to this project to view or edit its settings.
          </p>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer maxWidth="5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-white">
          Settings
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Manage your project settings, diff configuration, and retention
          policies.
        </p>
      </div>
      <ProjectSettingsForm projectId={projectId} userRole={me.data.role} />
    </PageContainer>
  );
}
