"use client";

import { Search } from "lucide-react";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { ariaKeyShortcuts, formatKeys } from "@/lib/commands/keys";
import { usePlatform } from "@/lib/commands/platform";

/** The key that opens the palette (the global `palette.open` command's). */
const PALETTE_KEYS = ["$mod+k"];

/**
 * The top bar's way into the ⌘K palette for anyone who has not met the key
 * (spec §5.3): a field-like button reading "Search or run a command…" with
 * the key beside it, "⌘K" on a Mac and "Ctrl K" elsewhere. Below the `md`
 * breakpoint the words go and the icon and the key stay. The key is shown and
 * announced (`aria-keyshortcuts`) for the platform it is on, as the rest of
 * the keyboard surface does.
 */
export function PaletteButton() {
  const platform = usePlatform();
  const setOpen = usePaletteStore((s) => s.setOpen);
  // ⌘ and K are one badge here, not two caps: "⌘K", "Ctrl K".
  const key = (formatKeys(PALETTE_KEYS, platform)[0] ?? []).join(
    platform === "mac" ? "" : " ",
  );
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open command palette"
      aria-keyshortcuts={ariaKeyShortcuts(PALETTE_KEYS, platform)}
      data-testid="top-bar-palette"
      className="flex h-8 items-center gap-2 rounded-md border border-edge bg-canvas px-2.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-ring md:w-64"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <span className="hidden min-w-0 flex-1 truncate text-left md:inline">
        Search or run a command…
      </span>
      <kbd className="shrink-0 rounded border border-edge bg-sunken px-1.5 py-0.5 font-mono text-xs text-fg-secondary">
        {key}
      </kbd>
    </button>
  );
}
