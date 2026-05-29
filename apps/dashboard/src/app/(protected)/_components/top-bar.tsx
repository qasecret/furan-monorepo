"use client";

import { Bell, Menu, Search } from "lucide-react";

import { useMobileSidebarStore } from "./use-mobile-sidebar";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { HelpButton } from "@/components/tour/help-button";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * App-shell top bar. The "search input" is a button that opens the cmdk
 * palette — there is no inline search; the palette is the search.
 *
 * On <md viewports a hamburger button precedes the search; it opens the
 * MobileSidebar drawer via `useMobileSidebarStore`. The hamburger is
 * `md:hidden` so it never shows on desktop where the inline sidebar is
 * always visible.
 *
 * The bell renders disabled for v1.0; a real notification feed lands in
 * a later phase (see plan-roadmap §7.1).
 */
export function TopBar() {
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const setMobileSidebarOpen = useMobileSidebarStore((s) => s.setOpen);

  return (
    <header
      className="h-14 border-b border-zinc-200 bg-zinc-50/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/50 flex items-center justify-between gap-3 px-4 md:px-6 shrink-0"
      data-testid="app-top-bar"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <button
          type="button"
          onClick={() => setMobileSidebarOpen(true)}
          className="md:hidden p-2 -ml-2 rounded-md text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-900/50 transition-colors shrink-0"
          data-testid="top-bar-menu"
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="relative w-full md:w-72 flex items-center bg-white border border-zinc-200 rounded-md pl-9 pr-3 md:pr-16 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 hover:border-zinc-300 dark:bg-zinc-900 dark:border-zinc-800 dark:hover:text-zinc-300 dark:hover:border-zinc-700 transition-colors text-left truncate"
          data-testid="top-bar-search"
          aria-label="Open command palette"
        >
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <span className="truncate">Jump to project, settings, account…</span>
          <span className="hidden md:inline-block absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 font-mono border border-zinc-200 bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-400 rounded px-1.5 py-0.5">
            ⌘K
          </span>
        </button>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <HelpButton />
        <ThemeToggle />
        <button
          type="button"
          disabled
          aria-disabled
          aria-label="Notifications (coming soon)"
          title="Notifications coming soon"
          className="p-2 rounded-md text-zinc-600 opacity-50 cursor-not-allowed dark:text-zinc-400"
          data-testid="top-bar-bell"
        >
          <Bell className="w-5 h-5" />
        </button>
      </div>
    </header>
  );
}
