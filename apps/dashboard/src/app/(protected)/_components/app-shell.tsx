import type { ReactNode } from "react";

import { MobileSidebar } from "./mobile-sidebar";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

interface Props {
  userRole: "admin" | "editor" | "guest";
  userEmail: string;
  userInitial: string;
  children: ReactNode;
}

/**
 * Full-viewport app shell: fixed sidebar on the left, topbar + scrolling
 * main region on the right. Server-renderable; interactive bits (sidebar
 * active state, topbar search + hamburger, mobile drawer) are client
 * leaves.
 *
 * Responsive: desktop (≥md) shows the inline Sidebar; mobile (<md) hides
 * it and surfaces the hamburger button in TopBar, which opens a Radix
 * Dialog drawer (MobileSidebar) with the same Sidebar inside.
 *
 * Main scroll region uses #050505 (one shade darker than zinc-950 cards)
 * so cards visually elevate against the canvas.
 */
export function AppShell({
  userRole,
  userEmail,
  userInitial,
  children,
}: Props) {
  return (
    <div className="flex h-screen bg-black text-white overflow-hidden">
      <Sidebar
        userRole={userRole}
        userEmail={userEmail}
        userInitial={userInitial}
        className="hidden md:flex"
      />
      <MobileSidebar
        userRole={userRole}
        userEmail={userEmail}
        userInitial={userInitial}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-auto bg-[#050505]">
          <div className="px-6 py-6 max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
