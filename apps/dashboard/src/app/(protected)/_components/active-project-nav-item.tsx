"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useActiveProjectStore } from "./use-active-project";

import { cn } from "@/lib/cn";

/**
 * "Current project" row shown nested beneath the Projects sidebar item while
 * the user is inside a project (`/projects/<id>/…`). Populated by
 * `<ProjectHeader>` through `useActiveProjectStore`, so the otherwise-flat
 * sidebar gains an at-a-glance "you are in this project" anchor. Renders
 * nothing outside a project.
 */
export function ActiveProjectNavItem() {
  const id = useActiveProjectStore((s) => s.id);
  const name = useActiveProjectStore((s) => s.name);
  const pathname = usePathname();

  if (!id || !name) return null;
  const href = `/projects/${id}`;
  const isActive = pathname.startsWith(href);

  return (
    <div className="ml-3 mt-0.5 border-l border-zinc-200 pl-3 dark:border-zinc-800">
      <Link
        href={href}
        data-testid="sidebar-active-project"
        className={cn(
          "flex items-center rounded-md px-2 py-1 text-xs font-medium transition-colors",
          isActive
            ? "text-brand"
            : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white",
        )}
      >
        <span className="truncate">{name}</span>
      </Link>
    </div>
  );
}
