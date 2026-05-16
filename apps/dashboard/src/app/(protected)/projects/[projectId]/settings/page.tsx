import { notFound, redirect } from "next/navigation";

import { ProjectSettingsForm } from "./_components/project-settings-form";

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

/**
 * /projects/[projectId]/settings — open to any project member for read
 * (server-side tRPC `projectMember` middleware enforces it), but the
 * Save button is disabled-with-tooltip for guests. Editors + admins
 * can submit the update mutation.
 *
 * The page is a Server Component only to fetch the current user (so we
 * can pass the role into the client island); the form itself + project
 * data load go through the typed tRPC client on the client side.
 */
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

  // Probe the project so non-members see a 404 instead of a spinning
  // client-side query that ultimately resolves to FORBIDDEN. Admins
  // bypass the membership check at the API layer.
  const project = await apiGet<Project>(`/projects/${projectId}`);
  if (project.status === 404) {
    notFound();
  }
  if (project.status === 403 || !project.data) {
    return (
      <Card>
        <h1 className="text-xl font-bold">403 — not a project member</h1>
        <p className="text-sm text-neutral-600">
          You need to be added to this project to view or edit its settings.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4 p-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Project settings</h1>
        <p className="text-sm text-neutral-600">
          Project: <span className="font-medium">{project.data.name}</span>
        </p>
      </div>
      <ProjectSettingsForm projectId={projectId} userRole={me.data.role} />
    </div>
  );
}
