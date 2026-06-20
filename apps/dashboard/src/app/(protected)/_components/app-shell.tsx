import type { ReactNode } from "react";

import { TopBar } from "./top-bar";

interface Props {
  userRole: "admin" | "editor" | "guest";
  userEmail: string;
  userInitial: string;
  children: ReactNode;
}

/**
 * Full-viewport app shell: a top bar (with the project + view selectors that
 * replaced the rail) over a full-width scrolling main region. The left sidebar
 * was removed in U7 (ADR-051) — navigation lives in the header now.
 */
export function AppShell({
  userRole,
  userEmail,
  userInitial,
  children,
}: Props) {
  return (
    <div className="flex h-screen flex-col bg-white text-zinc-950 dark:bg-black dark:text-white overflow-hidden">
      <TopBar email={userEmail} initial={userInitial} role={userRole} />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-[#050505]">
        {children}
      </main>
    </div>
  );
}
