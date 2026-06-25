"use client";

import { create } from "zustand";

/**
 * Open/close state for the mobile sidebar drawer. A zustand store (not context)
 * so the TopBar hamburger and the Sidebar — siblings under AppShell — can share
 * it without a provider. Desktop keeps the sidebar always visible and ignores
 * this.
 */
interface State {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useSidebarStore = create<State>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}));
