import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ProjectSettingsForm } from "./_components/project-settings-form";

import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

interface Me {
  id: string;
  role: "admin" | "editor" | "guest";
}

interface Project {
  id: string;
  name: string;
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

  const project = await apiGet<Project>(`/projects/${projectId}`);
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
          You need to be added to this project to view or edit its settings.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Project settings
        </h1>
        <p className="text-sm text-zinc-400">
          Project:{" "}
          <span className="font-medium text-zinc-200">{project.data.name}</span>
        </p>
      </div>
      <ProjectSettingsForm projectId={projectId} userRole={me.data.role} />
    </div>
  );
}
