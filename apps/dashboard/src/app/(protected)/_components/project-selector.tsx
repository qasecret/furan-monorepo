"use client";

import { FolderKanban } from "lucide-react";
import { usePathname } from "next/navigation";

import { useCurrentProject } from "./current-project-provider";

import { cn } from "@/lib/cn";

/**
 * Header project context (ADR-052) — a FIXED, non-interactive label. The
 * project is admin-assigned; there is no switching, creating, or listing here
 * (those moved to Admin -> Projects). Shows the project the user is within
 * (`urlProject ?? default`). De-emphasised on workspace-global routes
 * (Analytics/Admin) where it doesn't scope the page (carried over from #277).
 */
export function ProjectSelector() {
  const { currentProjectId, projects } = useCurrentProject();
  const pathname = usePathname() ?? "";

  const urlProject = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const targetId = urlProject ?? currentProjectId;
  const name = projects.find((p) => p.id === targetId)?.name;
  const scopedOut = /^\/(analytics|admin)(\/|$)/.test(pathname);

  return (
    <div
      data-testid="project-selector-label"
      title={
        scopedOut
          ? "Analytics and Admin span all projects — not just this one"
          : undefined
      }
      className={cn(
        "flex items-center gap-2 rounded-md border border-edge px-2.5 py-1.5 text-sm font-medium text-fg",
        scopedOut && "opacity-60",
      )}
    >
      <FolderKanban className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="max-w-[12rem] truncate">{name ?? "No project"}</span>
    </div>
  );
}
