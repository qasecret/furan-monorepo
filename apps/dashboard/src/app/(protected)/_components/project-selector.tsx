"use client";

import {
  Check,
  ChevronsUpDown,
  FolderKanban,
  LayoutGrid,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { useCurrentProject } from "./current-project-provider";

import { CreateProjectDialog } from "@/app/(protected)/projects/_components/create-project-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Header project context (ADR-049). 0 projects → muted label (+ admin create);
 * 1 → static chip; 2+ → a switch dropdown. Switching persists the default via
 * the provider; "All projects…" routes to the kept /projects grid.
 */
export function ProjectSelector({ userRole }: { userRole: string }) {
  const { currentProject, projects, setCurrentProject } = useCurrentProject();
  const [createOpen, setCreateOpen] = useState(false);
  const isAdmin = userRole === "admin";

  const chip =
    "flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100";

  if (projects.length === 0) {
    return (
      <div className={chip} data-testid="project-selector-empty">
        <FolderKanban className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
        <span className="text-zinc-500">No project</span>
        {isAdmin && (
          <>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="text-brand hover:underline"
              data-testid="project-create-empty"
            >
              Create
            </button>
            <CreateProjectDialog
              open={createOpen}
              onOpenChange={setCreateOpen}
              hideTrigger
            />
          </>
        )}
      </div>
    );
  }

  if (projects.length === 1) {
    return (
      <div className={chip} data-testid="project-selector-single">
        <FolderKanban className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
        <span className="max-w-[12rem] truncate">{currentProject?.name}</span>
      </div>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Switch project"
            data-testid="project-selector-trigger"
            className={`${chip} hover:bg-zinc-100 dark:hover:bg-zinc-900`}
          >
            <FolderKanban
              className="h-4 w-4 shrink-0 text-zinc-500"
              aria-hidden
            />
            <span className="max-w-[12rem] truncate">
              {currentProject?.name ?? "Select project"}
            </span>
            <ChevronsUpDown
              className="h-4 w-4 shrink-0 text-zinc-500"
              aria-hidden
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[14rem]">
          {projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              data-testid={`project-option-${p.id}`}
              onSelect={() => setCurrentProject(p.id)}
            >
              <span className="truncate">{p.name}</span>
              {p.id === currentProject?.id && (
                <Check className="ml-auto h-4 w-4 text-brand" aria-hidden />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {isAdmin && (
            <DropdownMenuItem
              data-testid="project-create"
              onSelect={(e) => {
                e.preventDefault();
                setCreateOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Create project
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild data-testid="project-all">
            <Link href="/projects">
              <LayoutGrid className="mr-2 h-4 w-4" aria-hidden />
              All projects…
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin && (
        <CreateProjectDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          hideTrigger
        />
      )}
    </>
  );
}
