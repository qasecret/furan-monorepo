"use client";

import { Search } from "lucide-react";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { KeyBadge } from "@/components/shortcuts/key-caps";
import { ariaKeyShortcuts, formatKeys } from "@/lib/commands/keys";
import { usePlatform } from "@/lib/commands/platform";

/** The key that opens the palette (the global `palette.open` command's). */
const PALETTE_KEYS = ["$mod+k"];

/**
 * The top bar's way into the ⌘K palette for anyone who has not met the key
 * (spec §5.3): a field-like button reading "Search or run a command…" with
 * the key beside it, "⌘K" on a Mac and "Ctrl K" elsewhere.
 *
 * The button's name is its visible text (WCAG 2.5.3, Label in Name; Ruling
 * R19): no `aria-label`. Below `md` the words are visually hidden
 * (`max-md:sr-only`, which, unlike `sr-only md:not-sr-only`, leaves the
 * `truncate` of the wider layouts alone) and remain the name. The key badge
 * is `aria-hidden`: `aria-keyshortcuts` says it, for the platform it is on.
 *
 * It gives up width as the screen narrows, as the bar's left cluster (the
 * sidebar toggle and the project label) needs the room: the badge goes
 * below `sm`, the field is `w-40` from `md` and `w-64` from `lg`.
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
      aria-keyshortcuts={ariaKeyShortcuts(PALETTE_KEYS, platform)}
      data-testid="top-bar-palette"
      className="flex h-8 items-center gap-2 rounded-md border border-edge bg-canvas px-2.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-ring md:w-40 lg:w-64"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left max-md:sr-only">
        Search or run a command…
      </span>
      <KeyBadge
        aria-hidden="true"
        className="shrink-0 text-fg-secondary max-sm:hidden"
      >
        {key}
      </KeyBadge>
    </button>
  );
}
