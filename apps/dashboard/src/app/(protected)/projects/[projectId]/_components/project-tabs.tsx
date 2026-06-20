"use client";

import { RouteTabs } from "@/components/ui/route-tabs";

interface Props {
  projectId: string;
}

/**
 * Project-scoped tab strip rendered inside the `(protected)/projects/[id]`
 * layout. Delegates active-matching + presentation to the shared RouteTabs.
 */
export function ProjectTabs({ projectId }: Props) {
  return (
    <RouteTabs
      tabs={[
        { label: "Builds", href: `/projects/${projectId}/builds` },
        { label: "Variations", href: `/projects/${projectId}/variations` },
        { label: "Settings", href: `/projects/${projectId}/settings` },
      ]}
    />
  );
}
