"use client";

import { create } from "zustand";

/**
 * Whether the `?` sheet (Keyboard shortcuts) is open. A store, so the
 * `help.shortcuts` command and the Help menu can open it from anywhere.
 */
export const useShortcutsSheet = create<{
  open: boolean;
  setOpen(open: boolean): void;
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
