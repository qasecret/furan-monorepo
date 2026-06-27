import { redirect } from "next/navigation";

import { NoProject } from "@/app/(protected)/_components/no-project";
import { resolveLanding } from "@/app/(protected)/_lib/resolve-landing";
import { apiGet } from "@/lib/api-client";
import { isAtLeastAdmin, type ViewerRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

interface Me {
  role: ViewerRole;
  defaultProjectId: string | null;
}

interface Project {
  id: string;
}

/**
 * `/projects` is no longer a grid (U8). Single-project tenancy moved the
 * all-projects management surface to the Admin → Projects hub
 * (`/admin/projects`), so this legacy route just forwards:
 *
 *   - admins → the Admin → Projects hub (where they create + assign projects);
 *   - everyone else → their resolved landing (their default project's Builds),
 *     or the terminal no-project state when they have nothing to land on.
 *
 * The grid markup lives at `/admin/projects` — it is intentionally NOT
 * re-rendered here.
 */
export default async function ProjectsPage() {
  const meRes = await apiGet<Me>("/users/me").catch(() => ({
    status: 0,
    data: null as Me | null,
  }));

  // Admins (and owners) manage all projects from the dedicated hub.
  if (isAtLeastAdmin(meRes.data?.role)) redirect("/admin/projects");

  const projectsRes = await apiGet<Project[]>("/projects").catch(() => ({
    status: 0,
    data: [] as Project[],
  }));

  const destination = resolveLanding(
    {
      role: meRes.data?.role ?? "guest",
      defaultProjectId: meRes.data?.defaultProjectId ?? null,
    },
    projectsRes.data ?? [],
  );
  if (destination) redirect(destination);

  return <NoProject />;
}
