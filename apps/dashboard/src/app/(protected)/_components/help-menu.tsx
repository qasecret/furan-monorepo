"use client";

import { HelpCircle } from "lucide-react";
import { useRef } from "react";

import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { useTourOptional } from "@/components/tour/tour-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSingleKeyShortcuts } from "@/lib/commands/prefs";

/**
 * The top bar's Help menu (spec §5.3): a `?` button over three things.
 * Keyboard shortcuts opens the `?` sheet; Replay tour relaunches the current
 * page's tour and is there only when the page has one (it follows the page:
 * `useTourSteps` clears a page's tour as the page goes); Single-key shortcuts
 * is the WCAG 2.1.4 switch, the same one as in the sheet and the palette.
 */
export function HelpMenu() {
  // Tolerant of a missing provider, so the top bar mounts in isolation.
  const tour = useTourOptional();
  const [singleKeys, setSingleKeys] = useSingleKeyShortcuts();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          className="h-8 w-8 p-0 text-fg-secondary hover:text-fg"
          aria-label="Help"
          data-testid="top-bar-help"
        >
          <HelpCircle className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuItem
          // The menu item goes with the menu, and focus with it: the sheet
          // gives focus back to this button instead.
          onSelect={() =>
            useShortcutsSheet.getState().openFrom(trigger.current)
          }
        >
          Keyboard shortcuts
        </DropdownMenuItem>
        {tour?.state.pageId ? (
          <DropdownMenuItem onSelect={() => tour.relaunch()}>
            Replay tour
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={singleKeys}
          onCheckedChange={setSingleKeys}
        >
          Single-key shortcuts
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
