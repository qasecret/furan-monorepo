import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { LogoutButton } from "./_components/logout-button";

import { Providers } from "@/app/providers";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { apiGet } from "@/lib/api-client";
import { requireJwt } from "@/lib/auth";

interface Me {
  id: string;
  role: "admin" | "editor" | "guest";
}

/**
 * Mounts the cmdk palette + sonner Toaster once at the protected-layout
 * level so they're available on every authed page.
 *
 * The `/users/me` lookup is fetched server-side and degrades to "guest"
 * on miss so a transient auth-introspection failure can't broaden the
 * admin command surface. The JWT fence has already run (requireJwt
 * redirects to /login on miss), so a missing `me` payload here is a
 * legitimate "user isn't represented in the users table yet" case.
 */
export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireJwt();
  const me = await apiGet<Me>("/users/me").catch(() => ({
    status: 0,
    data: null as Me | null,
  }));
  const userRole: Me["role"] = me.data?.role ?? "guest";
  return (
    <Providers>
      <div className="min-h-screen p-6 max-w-6xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <nav className="flex gap-4 text-sm">
            <a href="/projects" className="underline">
              Projects
            </a>
            <a href="/account/tokens" className="underline">
              Tokens
            </a>
            {userRole === "admin" && (
              <>
                <a href="/admin/members" className="underline">
                  Members
                </a>
                <a href="/admin/installations" className="underline">
                  Installations
                </a>
              </>
            )}
          </nav>
          <LogoutButton />
        </header>
        {children}
      </div>
      <CommandPalette userRole={userRole} />
      <Toaster richColors position="bottom-right" />
    </Providers>
  );
}
