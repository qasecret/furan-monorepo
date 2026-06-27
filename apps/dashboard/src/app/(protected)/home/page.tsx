import { redirect } from "next/navigation";

import { NoProject } from "@/app/(protected)/_components/no-project";
import { resolveLanding } from "@/app/(protected)/_lib/resolve-landing";
import { apiGet } from "@/lib/api-client";
import type { ViewerRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

interface Me {
  role: ViewerRole;
  defaultProjectId: string | null;
}

interface Project {
  id: string;
}

/**
 * Authenticated landing resolver (U8). Both the post-login redirect and the
 * bare app URL (`/` → `/home`) funnel through here. We sit inside the
 * (protected) layout, so `requireJwt()` has already fenced unauthed traffic to
 * /login before this RSC runs.
 *
 * Resolve `/users/me` + `/projects` server-side, hand them to the pure
 * `resolveLanding`, and bounce to the destination it picks (the default
 * project's Builds, or the Admin → Projects hub for an admin with no default).
 * When it returns null — an editor with no project and no switcher — render the
 * terminal "no project assigned" state instead of redirecting in a loop.
 *
 * `me`/`projects` degrade to a guest/empty shape on a transient introspection
 * failure so a flaky `/users/me` can never widen access or 500 the home route.
 */
export default async function HomePage() {
  const [meRes, projectsRes] = await Promise.all([
    apiGet<Me>("/users/me").catch(() => ({
      status: 0,
      data: null as Me | null,
    })),
    apiGet<Project[]>("/projects").catch(() => ({
      status: 0,
      data: [] as Project[],
    })),
  ]);

  const me = {
    role: meRes.data?.role ?? "guest",
    defaultProjectId: meRes.data?.defaultProjectId ?? null,
  };
  const projects = projectsRes.data ?? [];

  const destination = resolveLanding(me, projects);
  if (destination) redirect(destination);

  return <NoProject />;
}
