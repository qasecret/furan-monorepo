"use client";

import { Fragment, useId, useMemo, type JSX } from "react";

import { useShortcutsSheet } from "./use-shortcuts-sheet";

import { useTourOptional } from "@/components/tour/tour-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import {
  bindingKey,
  formatKeys,
  isCharacterBinding,
  keyIdentity,
} from "@/lib/commands/keys";
import { usePlatform } from "@/lib/commands/platform";
import { useSingleKeyShortcuts } from "@/lib/commands/prefs";
import {
  resolveKeyMap,
  useRegisteredCommands,
  type ResolvedCommand,
} from "@/lib/commands/registry";
import type { CommandScope, Platform } from "@/lib/commands/types";

/** Each scope's heading (spec §8). A `Record`, so a new scope must name one. */
const HEADINGS: Record<CommandScope, string> = {
  batches: "On this page (Batches)",
  batch: "On this page (Batch)",
  viewer: "On this page (Diff viewer)",
  global: "Everywhere",
};

/** The sections, in order: the page's own commands, then every page's. */
const SECTION_ORDER: CommandScope[] = ["batches", "batch", "viewer", "global"];

/** One key of a command, as the sheet shows it. */
interface ShownKey {
  /** The `kbd` tokens: ["⌘", "K"], or ["G", "then", "I"] for a sequence. */
  tokens: string[];
  /** A letter or symbol key: what the single-key switch turns off. */
  character: boolean;
}

interface Row {
  id: string;
  label: string;
  keys: ShownKey[];
}

const SEQUENCE_WORD = "then";

/**
 * The rows of each scope. A key shows once: where the registry gives it to
 * another command (a page's `/` takes the global one), it is left out of this
 * command's row, so what the sheet lists is exactly what a key press runs.
 * A command with no key left has no row (palette only, or every key taken).
 * `commands` are the allowed ones, in registration order.
 */
function rowsByScope(
  commands: ResolvedCommand[],
  platform: Platform,
): Map<CommandScope, Row[]> {
  const winners = resolveKeyMap(commands);
  const byScope = new Map<CommandScope, Row[]>();
  for (const resolved of commands) {
    const { command, scope } = resolved;
    const bindings = (command.keys ?? []).filter(
      (b) => winners.get(keyIdentity(bindingKey(b))) === resolved,
    );
    if (bindings.length === 0) continue;
    const tokens = formatKeys(bindings, platform);
    const row: Row = {
      id: command.id,
      label: command.label,
      keys: bindings.map((b, i) => ({
        tokens: tokens[i] ?? [],
        character: isCharacterBinding(bindingKey(b)),
      })),
    };
    byScope.set(scope, [...(byScope.get(scope) ?? []), row]);
  }
  return byScope;
}

const KEY_CAP =
  "min-w-6 rounded border border-edge bg-sunken px-1.5 py-0.5 text-center font-mono text-xs";

/** One key: each token on its own cap, "then" as plain text between them. */
function Key({
  shown,
  off,
}: {
  shown: ShownKey;
  /** The switch is off and this key is a character key. */
  off: boolean;
}): JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <kbd className="inline-flex items-center gap-1">
        {shown.tokens.map((token, i) => (
          <Fragment key={i}>
            {i > 0 && " "}
            {token === SEQUENCE_WORD ? (
              <span className="font-sans text-fg-muted">{token}</span>
            ) : (
              <kbd className={cn(KEY_CAP, off ? "text-fg-muted" : "text-fg")}>
                {token}
              </kbd>
            )}
          </Fragment>
        ))}
      </kbd>
      {off && (
        <span className="text-fg-muted">(single-key shortcuts are off)</span>
      )}
    </span>
  );
}

function Section({
  heading,
  rows,
  singleKeys,
}: {
  heading: string;
  rows: Row[];
  singleKeys: boolean;
}): JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3
        id={headingId}
        className="text-xs font-medium uppercase tracking-wide text-fg-muted"
      >
        {heading}
      </h3>
      <ul className="space-y-1.5 text-sm">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-4">
            <span className="text-fg-secondary">{row.label}</span>
            <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs">
              {row.keys.map((shown, i) => (
                <Fragment key={i}>
                  {i > 0 && (
                    <span aria-hidden="true" className="text-fg-muted">
                      /
                    </span>
                  )}
                  <Key shown={shown} off={!singleKeys && shown.character} />
                </Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The `?` sheet (Keyboard shortcuts), generated from the command registry
 * (spec §5.1): the page's commands, then the ones everywhere, each with its
 * keys. It lists what the signed-in role may do (`allowed`), disabled commands
 * included, and leaves commands without keys to the palette. The footer holds
 * the single-key switch (WCAG 2.1.4) and, when the page has a tour, Replay
 * tour. Opened through `useShortcutsSheet`; mounted once, in the protected
 * layout.
 */
export function ShortcutsSheet(): JSX.Element {
  const open = useShortcutsSheet((s) => s.open);
  const setOpen = useShortcutsSheet((s) => s.setOpen);
  const commands = useRegisteredCommands();
  const platform = usePlatform();
  const [singleKeys, setSingleKeys] = useSingleKeyShortcuts();
  const tour = useTourOptional();
  const switchId = useId();
  const helpId = useId();

  const rows = useMemo(
    () => rowsByScope(commands, platform),
    [commands, platform],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // The sheet is its own description: a list of keys and a switch.
        aria-describedby={undefined}
        // Radix would focus the first tabbable element, which is the footer's
        // switch: Space or Enter would flip the stored WCAG 2.1.4 preference
        // unseen, and a screen reader would start below the list. Focus the
        // dialog itself (tabIndex -1) instead: it reads the title, then the
        // list, and the switch is a Tab away.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).focus();
        }}
        className="max-h-[85vh] max-w-lg overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        {SECTION_ORDER.map((scope) => {
          const sectionRows = rows.get(scope);
          return sectionRows ? (
            <Section
              key={scope}
              heading={HEADINGS[scope]}
              rows={sectionRows}
              singleKeys={singleKeys}
            />
          ) : null;
        })}
        <div className="space-y-3 border-t border-edge pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor={switchId} className="text-sm font-medium text-fg">
                Single-key shortcuts
              </label>
              <p id={helpId} className="text-xs text-fg-secondary">
                Turn off to stop letter and symbol keys from triggering actions.
                ⌘K, ⌘Z, arrows, Enter and Esc keep working.
              </p>
            </div>
            <Switch
              id={switchId}
              aria-describedby={helpId}
              checked={singleKeys}
              onCheckedChange={setSingleKeys}
            />
          </div>
          {tour?.state.pageId ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                // Out of the way first: the tour sits on the page behind.
                setOpen(false);
                tour.relaunch();
              }}
            >
              Replay tour
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
