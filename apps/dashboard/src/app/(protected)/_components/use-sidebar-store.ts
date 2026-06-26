"use client";

import { create } from "zustand";

export const SIDEBAR_COLLAPSED_KEY = "furan:sidebar:collapsed";

interface State {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
}

export const useSidebarStore = create<State>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
  collapsed: false,
  setCollapsed: (collapsed) => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    set({ collapsed });
  },
  toggleCollapsed: () => {
    const next = !get().collapsed;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    set({ collapsed: next });
  },
}));
