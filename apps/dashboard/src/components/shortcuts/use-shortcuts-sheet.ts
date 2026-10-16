"use client";

import { create } from "zustand";

/**
 * Whether the `?` sheet (Keyboard shortcuts) is open. A store, so the
 * `help.shortcuts` command and the Help menu can open it from anywhere.
 */
export const useShortcutsSheet = create<{
  open: boolean;
  /**
   * Where focus goes back to when the sheet closes, when whoever opened it
   * says so (see `openFrom`). Null: wherever focus was as it opened.
   */
  returnTo: HTMLElement | null;
  setOpen(open: boolean): void;
  /**
   * Opens the sheet and names the element focus returns to on close. For an
   * opener that is about to go (a menu item): the control that opened the
   * menu is the one to come back to.
   */
  openFrom(returnTo: HTMLElement | null): void;
}>((set) => ({
  open: false,
  returnTo: null,
  setOpen: (open) => set(open ? { open } : { open, returnTo: null }),
  openFrom: (returnTo) => set({ open: true, returnTo }),
}));
