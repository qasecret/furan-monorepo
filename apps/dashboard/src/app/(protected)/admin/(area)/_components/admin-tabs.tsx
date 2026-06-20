"use client";

import { RouteTabs } from "@/components/ui/route-tabs";

/**
 * Admin-area tab strip rendered inside `admin/(area)/layout.tsx`.
 */
export function AdminTabs() {
  return (
    <RouteTabs
      tabs={[
        { label: "Members", href: "/admin/members" },
        { label: "Projects", href: "/admin/projects" },
        { label: "Installations", href: "/admin/installations" },
      ]}
    />
  );
}
