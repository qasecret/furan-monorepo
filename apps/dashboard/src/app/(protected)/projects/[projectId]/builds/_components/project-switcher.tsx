"use client";

import { ChevronsUpDown } from "lucide-react";
import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  /** Test-only: render the menu open. */
  defaultOpen?: boolean;
}

interface ProjectListItem {
  id: string;
  name: string;
}

// `projects.list` is a REST-only endpoint; the tRPC client type does not
// include it. Cast through unknown so tests can mock it via @/lib/trpc while
// avoiding a compile error. At runtime this is replaced by the real REST
// query if a `list` procedure is ever added to the router.
type TrpcWithProjectList = {
  projects: {
    list: {
      useQuery: () => {
        data: ProjectListItem[] | undefined;
        isLoading?: boolean;
      };
    };
  };
};

/** Context-panel header: current project + dropdown to switch projects. */
export function ProjectSwitcher({ projectId, defaultOpen }: Props) {
  const { data } = (
    trpc as unknown as TrpcWithProjectList
  ).projects.list.useQuery();
  const projects = (data ?? []) as ProjectListItem[];
  const current = projects.find((p) => p.id === projectId);
  const others = projects.filter((p) => p.id !== projectId);

  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch project"
          data-testid="project-switcher-current"
          className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200 px-2 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          <span className="truncate">{current?.name ?? "Project"}</span>
          <ChevronsUpDown
            className="h-4 w-4 shrink-0 text-zinc-500"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {others.map((p) => (
          <DropdownMenuItem key={p.id} asChild>
            <Link href={`/projects/${p.id}/builds`}>{p.name}</Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem asChild>
          <Link href="/projects">All projects…</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
