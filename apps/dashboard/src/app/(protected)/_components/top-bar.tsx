"use client";

import { Bell, Search } from "lucide-react";
import Link from "next/link";

import { AccountMenu } from "./account-menu";
import { ProjectSelector } from "./project-selector";
import { ViewSelector } from "./view-selector";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { HelpButton } from "@/components/tour/help-button";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * App-shell top bar. The "search input" is a button that opens the cmdk
 * palette — there is no inline search; the palette is the search.
 *
 * The left cluster contains: ProjectSelector → ViewSelector → palette search.
 * The right cluster contains: HelpButton → ThemeToggle → bell → AccountMenu.
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
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);

  return (
    <header
      className="h-14 border-b border-zinc-200 bg-zinc-50/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/50 flex items-center justify-between gap-3 px-4 md:px-6 shrink-0"
      data-testid="app-top-bar"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Link
          href="/inbox"
          aria-label="Furan home"
          data-testid="top-bar-logo"
          className="flex shrink-0 items-center gap-2"
        >
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-brand">
            <div className="h-2.5 w-2.5 rounded-sm bg-black" />
          </div>
          <span className="hidden text-lg font-semibold tracking-tight text-zinc-950 lg:inline dark:text-white">
            Furan
          </span>
        </Link>
        <ProjectSelector />
        <ViewSelector userRole={role} />
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="relative w-full md:w-72 md:shrink-0 flex items-center bg-white border border-zinc-200 rounded-md pl-9 pr-3 md:pr-16 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 hover:border-zinc-300 dark:bg-zinc-900 dark:border-zinc-800 dark:hover:text-zinc-300 dark:hover:border-zinc-700 transition-colors text-left truncate"
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
        <AccountMenu email={email} initial={initial} role={role} />
      </div>
    </header>
  );
}
