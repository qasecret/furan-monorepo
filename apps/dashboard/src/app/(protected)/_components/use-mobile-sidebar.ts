"use client";

import { create } from "zustand";

/**
 * Open/close state for the mobile sidebar drawer.
 *
 * Mirrors the `usePaletteStore` zustand pattern from
 * `apps/dashboard/src/components/cmdk/use-command-palette.ts` so the
 * topbar hamburger button (separate React tree from the drawer surface)
 * can flip the drawer open without prop-drilling or context.
 *
 * The drawer itself auto-closes on every pathname change (handled inside
 * `<MobileSidebar>`), so calling `setOpen(false)` from nav-item click
 * handlers is unnecessary.
 */
interface State {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useMobileSidebarStore = create<State>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
