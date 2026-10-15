"use client";

import { Fragment, useId } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/**
 * One row: its keys, as on the key caps (a sequence is written with spaces,
 * "G I" for G then I), and what they do. Two or three keys share a row when
 * they are a set (J / K: next / previous).
 */
interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  /** Where the keys work. */
  title: string;
  shortcuts: Shortcut[];
}

/**
 * Exactly the keys that are bound, by where they work: the viewer's
 * (`useDiffViewerShortcuts`) and the ones on every page (`GlobalShortcuts`,
 * the command palette's ⌘K). A second key for the same thing (X for R, = for
 * +, Backspace for Delete) is not listed again. `/` is, though it is the
 * viewer's second way into the palette: this list used to teach it as "Focus
 * filter bar", so what it really does is shown. tests/global-shortcuts.test.tsx
 * presses every key listed here, where it says the key works, and checks every
 * key the viewer binds is listed.
 */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "In the diff viewer",
    shortcuts: [
      { keys: ["J", "K"], label: "Next / previous step to review" },
      { keys: ["A"], label: "Approve the step" },
      { keys: ["R"], label: "Reject the step" },
      { keys: ["⌘Z"], label: "Undo your last review action" },
      { keys: ["←", "→"], label: "Previous / next step of this test" },
      { keys: ["N", "P"], label: "Next / previous changed region" },
      { keys: ["D"], label: "Difference view, on or off" },
      { keys: ["O"], label: "Next view: side by side, overlay, difference" },
      { keys: ["H"], label: "Region highlight, on or off" },
      { keys: ["[", "]"], label: "Previous / next viewport" },
      { keys: ["+", "-", "0"], label: "Zoom in / out / to fit" },
      { keys: ["C"], label: "Comments, open or closed" },
      { keys: ["I"], label: "Ignore-region editor, on or off" },
      { keys: ["Delete"], label: "Delete the selected ignore region" },
      { keys: ["⌘C", "⌘V"], label: "Copy / paste an ignore region" },
      { keys: ["/"], label: "Open the command palette" },
      {
        keys: ["Esc"],
        label:
          "Leave the editor and clear the selection; on the done card, back to the batch",
      },
    ],
  },
  {
    title: "Everywhere",
    shortcuts: [
      { keys: ["⌘K"], label: "Open the command palette" },
      { keys: ["G I"], label: "Go to Batches" },
      { keys: ["G P"], label: "Go to Projects" },
      { keys: ["?"], label: "Show this list" },
    ],
  },
];

const KEY_CAP =
  "min-w-6 rounded border border-edge bg-sunken px-1.5 py-0.5 text-center font-mono text-xs text-fg";

function Group({ group }: { group: ShortcutGroup }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3
        id={headingId}
        className="text-xs font-medium uppercase tracking-wide text-fg-muted"
      >
        {group.title}
      </h3>
      <ul className="space-y-1.5 text-sm">
        {group.shortcuts.map((s) => (
          <li
            key={s.keys.join(" / ")}
            className="flex items-center justify-between gap-4"
          >
            <span className="text-fg-secondary">{s.label}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
              {s.keys.map((key, i) => (
                <Fragment key={key}>
                  {i > 0 && <span>/</span>}
                  {/* One key, or the keys of a sequence, each on its cap. */}
                  <kbd data-shortcut={key} className="flex items-center gap-1">
                    {key.split(" ").map((cap) => (
                      <kbd key={cap} className={KEY_CAP}>
                        {cap}
                      </kbd>
                    ))}
                  </kbd>
                </Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            ⌘ is Ctrl on Windows and Linux. While you type in a field, only ⌘K
            works.
          </DialogDescription>
        </DialogHeader>
        {SHORTCUT_GROUPS.map((group) => (
          <Group key={group.title} group={group} />
        ))}
      </DialogContent>
    </Dialog>
  );
}
