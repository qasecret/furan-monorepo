"use client";

import { Bell, ChevronsLeft, ChevronsRight, Menu } from "lucide-react";

import { AccountMenu } from "./account-menu";
import { ProjectSelector } from "./project-selector";
import { useSidebarStore } from "./use-sidebar-store";

import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * App-shell top bar, beside the navigation Sidebar.
 *
 * Left cluster: mobile drawer toggle → desktop sidebar collapse/expand toggle
 * → ProjectSelector. Right cluster: ThemeToggle → bell → AccountMenu.
 *
 * The command-palette search button + tour HelpButton were removed in #308
 * when the collapse toggle took their slot; the palette is now reached via the
 * global Cmd/Ctrl+K handler.
 *
 * The bell renders disabled for v1.0; a real notification feed lands in
 * a later phase (see plan-roadmap §7.1).
 */
interface TopBarProps {
  email: string;
  initial: string;
  role: string;
}

export function TopBar({ email, initial, role }: TopBarProps) {
  const toggleDrawer = useSidebarStore((s) => s.toggle);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);

  return (
    <header
      className="h-14 border-b border-edge bg-sunken/80 backdrop-blur-sm flex items-center justify-between gap-3 px-4 md:px-6 shrink-0"
      data-testid="app-top-bar"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Mobile: open drawer */}
        <button
          type="button"
          onClick={toggleDrawer}
          aria-label="Open menu"
          data-testid="sidebar-toggle"
          className="-ml-1 rounded-md p-2 text-fg-secondary hover:bg-hover focus-ring md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        {/* Desktop: collapse / expand sidebar */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-testid="sidebar-collapse-toggle"
          className="hidden md:flex -ml-1 rounded-md p-2 text-fg-secondary hover:bg-hover focus-ring"
        >
          {collapsed ? (
            <ChevronsRight className="h-5 w-5" />
          ) : (
            <ChevronsLeft className="h-5 w-5" />
          )}
        </button>
        <ProjectSelector />
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <ThemeToggle />
        <button
          type="button"
          disabled
          aria-disabled
          aria-label="Notifications (coming soon)"
          title="Notifications coming soon"
          className="p-2 rounded-md text-fg-secondary opacity-50 cursor-not-allowed"
          data-testid="top-bar-bell"
        >
          <Bell className="w-5 h-5" />
        </button>
        <AccountMenu email={email} initial={initial} role={role} />
      </div>
    </header>
  );
}
