"use client";

import { usePathname } from "next/navigation";

import { PrimaryTabs, type PrimaryTabDef } from "@/components/ui/primary-tabs";

/**
 * Admin-area tab strip rendered inside `admin/(area)/layout.tsx`. Client-only so
 * it can read `usePathname()` for active state; the surrounding layout stays
 * server-rendered. Visual treatment delegated to the shared `PrimaryTabs`.
 */
export function AdminTabs() {
  const pathname = usePathname();
  const tabs: PrimaryTabDef[] = [
    { label: "Members", href: "/admin/members", isActive: false },
    { label: "Installations", href: "/admin/installations", isActive: false },
  ].map((tab) => ({
    ...tab,
    isActive: pathname === tab.href || pathname.startsWith(`${tab.href}/`),
  }));

  return <PrimaryTabs tabs={tabs} />;
}
