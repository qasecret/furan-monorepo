"use client";

import { create } from "zustand";

/** One review action the reviewer can still take back. */
export interface UndoEntry {
  actionId: string;
  /** What the toast said, e.g. "Approved home". */
  label: string;
  /** The runs the action decided in. */
  runIds: string[];
}

/** How many actions ⌘Z can walk back through. */
const UNDO_STACK_CAP = 20;

interface UndoState {
  /** Oldest first; the newest entry is last. */
  stack: UndoEntry[];
  push(entry: UndoEntry): void;
  /** Removes and returns the newest entry. */
  take(): UndoEntry | undefined;
  /** Removes the entry for an action, e.g. once it has been undone. */
  drop(actionId: string): void;
}

/**
 * This session's review actions, newest last. Memory only: reloading the page
 * forgets them, and a decision made before that is undone from its chip on the
 * step, not with ⌘Z.
 */
export const useUndoStore = create<UndoState>((set, get) => ({
  stack: [],
  push: (entry) =>
    set((s) => ({ stack: [...s.stack, entry].slice(-UNDO_STACK_CAP) })),
  take: () => {
    const newest = get().stack.at(-1);
    if (newest) set((s) => ({ stack: s.stack.slice(0, -1) }));
    return newest;
  },
  drop: (actionId) =>
    set((s) => ({ stack: s.stack.filter((e) => e.actionId !== actionId) })),
}));
