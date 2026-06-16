"use client";

import { create } from "zustand";

import type { BreadcrumbCrumb } from "@/components/ui/breadcrumbs";

/**
 * Global breadcrumb trail rendered by the TopBar.
 *
 * Exposed as a zustand store (mirroring `usePaletteStore` /
 * `useMobileSidebarStore`) so any route — server or client — can publish its
 * trail via the `<SetBreadcrumbs>` client island without prop-drilling.
 *
 * `pathname` records the route the items were published for. The TopBar only
 * trusts the trail while `pathname` matches the current route, so a page that
 * renders no `<SetBreadcrumbs>` (or an early-return error branch) falls back to
 * a pathname-derived crumb instead of showing the previous page's stale trail.
 */
interface State {
  items: BreadcrumbCrumb[];
  pathname: string | null;
  setItems: (items: BreadcrumbCrumb[], pathname: string) => void;
}

export const useBreadcrumbsStore = create<State>((set) => ({
  items: [],
  pathname: null,
  setItems: (items, pathname) => set({ items, pathname }),
}));
