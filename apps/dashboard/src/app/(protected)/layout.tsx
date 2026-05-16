import type { ReactNode } from "react";

import { Providers } from "@/app/providers";
import { requireJwt } from "@/lib/auth";

export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireJwt();
  return (
    <Providers>
      <div className="min-h-screen p-6 max-w-6xl mx-auto">
        <header className="mb-6">
          <nav className="flex gap-4 text-sm">
            <a href="/projects" className="underline">
              Projects
            </a>
            <a href="/account/tokens" className="underline">
              Tokens
            </a>
            <a href="/admin/members" className="underline">
              Members
            </a>
          </nav>
        </header>
        {children}
      </div>
    </Providers>
  );
}
