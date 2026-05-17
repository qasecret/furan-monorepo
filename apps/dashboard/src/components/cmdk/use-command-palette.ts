"use client";

import { create } from "zustand";

/**
 * Global open/close state for the cmdk command palette.
 *
 * Exposed as a zustand store (rather than React context) so non-React
 * call sites — namely the diff viewer's tinykeys handler for `/` — can
 * call `usePaletteStore.getState().setOpen(true)` without needing a
 * provider in scope.
 */
interface State {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const usePaletteStore = create<State>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}));
