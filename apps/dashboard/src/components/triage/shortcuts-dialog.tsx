"use client";

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

const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "↑ / ↓ (j / k)", label: "Move selection" },
  { keys: "a", label: "Approve selected row" },
  { keys: "r", label: "Reject selected row" },
  { keys: "Enter", label: "Open diff viewer" },
  { keys: "Cmd / Ctrl + Enter", label: "Open diff viewer in new tab" },
  { keys: "g i", label: "Go to Inbox" },
  { keys: "g p", label: "Go to Projects" },
  { keys: "/", label: "Focus filter bar" },
  { keys: "?", label: "Show this dialog" },
  { keys: "Esc", label: "Clear selection / close dialog" },
];

export function ShortcutsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Reference for the keys that drive list navigation and row actions.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <li
              key={s.keys}
              className="flex items-center justify-between gap-4"
            >
              <kbd className="rounded border border-edge bg-sunken px-2 py-0.5 text-xs">
                {s.keys}
              </kbd>
              <span className="text-fg-secondary">{s.label}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
