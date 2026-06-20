"use client";

import { usePathname } from "next/navigation";

import { PrimaryTabs, type PrimaryTabDef } from "./primary-tabs";

export interface RouteTabDef {
  label: string;
  href: string;
  badge?: string;
  disabled?: boolean;
}

/**
 * Pathname-aware tab strip: computes `isActive` (exact href OR `${href}/` deep
 * route) and delegates rendering to `PrimaryTabs`. Shared by the project and
 * admin section headers so the active-matching lives in one place.
 */
export function RouteTabs({ tabs }: { tabs: RouteTabDef[] }) {
  const pathname = usePathname();
  const resolved: PrimaryTabDef[] = tabs.map((t) => ({
    ...t,
    isActive: pathname === t.href || pathname.startsWith(`${t.href}/`),
  }));
  return <PrimaryTabs tabs={resolved} />;
}
