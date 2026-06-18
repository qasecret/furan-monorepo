"use client";

import { usePathname } from "next/navigation";

import { PrimaryTabs, type PrimaryTabDef } from "@/components/ui/primary-tabs";

interface Props {
  projectId: string;
}

/**
 * Project-scoped tab strip rendered inside the `(protected)/projects/[id]`
 * layout. Client-only so it can read `usePathname()` for active-state
 * highlighting; the surrounding layout stays server-rendered.
 *
 * Active match is permissive: any pathname that equals the tab's href OR
 * starts with `${href}/` keeps the tab highlighted, so deep routes
 * under a tab keep it highlighted (e.g. `/projects/<id>/builds/<buildId>` keeps
 * the Builds tab active).
 *
 * Visual presentation is delegated to the shared `<PrimaryTabs>` primitive
 * (components/ui/primary-tabs.tsx) so all tab strips in the app share one
 * border-underline + density treatment.
 */
export function ProjectTabs({ projectId }: Props) {
  const pathname = usePathname();
  const tabs: PrimaryTabDef[] = [
    {
      label: "Builds",
      href: `/projects/${projectId}/builds`,
      isActive: false,
    },
    {
      label: "Variations",
      href: `/projects/${projectId}/variations`,
      isActive: false,
    },
    {
      label: "Settings",
      href: `/projects/${projectId}/settings`,
      isActive: false,
    },
  ].map((tab) => ({
    ...tab,
    isActive: pathname === tab.href || pathname.startsWith(`${tab.href}/`),
  }));

  return <PrimaryTabs tabs={tabs} />;
}
