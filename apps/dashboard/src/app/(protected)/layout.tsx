import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { AppShell } from "./_components/app-shell";
import { CurrentProjectProvider } from "./_components/current-project-provider";

import { Providers } from "@/app/providers";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { GlobalShortcuts } from "@/components/triage/global-shortcuts";
import { apiGet } from "@/lib/api-client";
import { requireJwt } from "@/lib/auth";
import type { ViewerRole } from "@/lib/roles";

interface Me {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: ViewerRole;
  defaultProjectId: string | null;
}

interface ProjectApiItem {
  id: string;
  name: string;
}

/**
 * Mounts the AppShell + cmdk palette + sonner Toaster once at the
 * protected-layout level so they're available on every authed page.
 *
 * The `/users/me` lookup is fetched server-side and degrades to a "guest"
 * shape on miss so a transient auth-introspection failure can't broaden
 * the admin command surface. The JWT fence has already run (requireJwt
 * redirects to /login on miss), so a missing `me` payload here is a
 * legitimate "user isn't represented in the users table yet" case.
 */
export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireJwt();
  const [me, projectsRes] = await Promise.all([
    apiGet<Me>("/users/me").catch(() => ({
      status: 0,
      data: null as Me | null,
    })),
    apiGet<ProjectApiItem[]>("/projects").catch(() => ({
      status: 0,
      data: [] as ProjectApiItem[],
    })),
  ]);
  // A valid JWT whose user was deactivated (or demoted to no access) now gets a
  // 403 from the API (account_inactive). /users/me is self-readable by any
  // authenticated user, so a 403 here means the account is disabled — bounce to
  // login with a reason instead of silently degrading to a guest shell. (The
  // login page does not auto-redirect authed users, so this can't loop.)
  if (me.status === 403) {
    redirect("/login?reason=account_inactive");
  }
  const userRole: Me["role"] = me.data?.role ?? "guest";
  const userEmail = me.data?.email ?? "";
  const userInitial = (me.data?.email ?? me.data?.role ?? "U")
    .charAt(0)
    .toUpperCase();
  const projects = (projectsRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
  }));

  return (
    <Providers>
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId={me.data?.defaultProjectId ?? null}
      >
        <AppShell
          userRole={userRole}
          userEmail={userEmail}
          userInitial={userInitial}
        >
          {children}
        </AppShell>
        <CommandPalette userRole={userRole} />
        <GlobalShortcuts />
        <Toaster richColors theme="dark" position="bottom-right" />
      </CurrentProjectProvider>
    </Providers>
  );
}
