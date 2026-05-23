"use client";

import { Bell, Search } from "lucide-react";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";

/**
 * App-shell top bar. The "search input" is a button that opens the cmdk
 * palette — there is no inline search; the palette is the search.
 *
 * The bell renders disabled for v1.0; a real notification feed lands in
 * a later phase (see plan-roadmap §7.1).
 */
export function TopBar() {
  const setOpen = usePaletteStore((s) => s.setOpen);

  return (
    <header
      className="h-14 border-b border-zinc-800 bg-zinc-950/50 flex items-center justify-between px-6 shrink-0"
      data-testid="app-top-bar"
    >
      <div className="flex items-center gap-4 flex-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="relative w-72 flex items-center bg-zinc-900 border border-zinc-800 rounded-md pl-9 pr-16 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:border-zinc-700 transition-colors text-left"
          data-testid="top-bar-search"
          aria-label="Open command palette"
        >
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          Jump to project, settings, account…
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-600 font-mono border border-zinc-800 rounded px-1.5 py-0.5">
            ⌘K
          </span>
        </button>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled
          aria-disabled
          aria-label="Notifications (coming soon)"
          title="Notifications coming soon"
          className="p-2 rounded-md text-zinc-600 opacity-50 cursor-not-allowed"
          data-testid="top-bar-bell"
        >
          <Bell className="w-5 h-5" />
        </button>
      </div>
    </header>
  );
}
