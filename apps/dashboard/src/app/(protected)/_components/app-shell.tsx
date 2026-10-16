import type { ReactNode } from "react";

import { Sidebar } from "./sidebar";
import { SkipLink } from "./skip-link";
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
 *
 * The skip link is the first focusable element, ahead of the sidebar and the
 * top bar; it takes focus to `<main id="main">`, which is focusable by script
 * only (`tabIndex={-1}`) and shows no ring, being a region and not a control.
 */
export function AppShell({
  userRole,
  userEmail,
  userInitial,
  children,
}: Props) {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-fg">
      <SkipLink targetId="main" />
      <Sidebar userRole={userRole} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar email={userEmail} initial={userInitial} role={userRole} />
        <main
          id="main"
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
