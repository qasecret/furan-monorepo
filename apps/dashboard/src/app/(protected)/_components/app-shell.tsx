import type { ReactNode } from "react";

import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

import type { ViewerRole } from "@/lib/roles";

interface Props {
  userRole: ViewerRole;
  userEmail: string;
  userInitial: string;
  children: ReactNode;
}

/**
 * Full-viewport app shell: a left navigation sidebar (the Batches review
 * destination + admin items) beside a top bar over a bounded-scroll main
 * region. The sidebar was reintroduced (superseding ADR-051's header-only nav)
 * to match the reference layout; the project context stays in the top bar.
 */
export function AppShell({
  userRole,
  userEmail,
  userInitial,
  children,
}: Props) {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-fg">
      <Sidebar userRole={userRole} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar email={userEmail} initial={userInitial} role={userRole} />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
          {children}
        </main>
      </div>
    </div>
  );
}
