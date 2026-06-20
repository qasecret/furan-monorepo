"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { ProjectTabs } from "./project-tabs";

import { PageHeader } from "@/components/ui/page-header";
import { recordRecentProject } from "@/lib/recent-projects";

/**
 * Project-scoped header rendered by the project layout: the project name as
 * the section identity, with the Builds / Runs / Variations / Settings tab
 * strip beneath it.
 *
 * It also owns the project's nav side effect (record the visit for the
 * command palette's Recent group), which runs regardless of whether the header
 * itself is shown.
 *
 * On the full-screen diff viewer (`/checkpoints/`, `/diffs/`) the header
 * renders nothing — that surface owns its own `ContextualHeader`, so showing
 * the project chrome there would double up. The breadcrumb trail still appears
 * globally in the TopBar.
 */
export function ProjectHeader({
  projectId,
  name,
}: {
  projectId: string;
  name: string;
}) {
  const pathname = usePathname();
  useEffect(() => {
    recordRecentProject({ id: projectId, name });
  }, [projectId, name]);

  const isFocusedView = /\/(checkpoints|diffs)\//.test(pathname);
  if (isFocusedView) return null;

  return (
    <div className="space-y-4">
      <PageHeader title={name} className="px-6 pt-6" />
      <ProjectTabs projectId={projectId} />
    </div>
  );
}
