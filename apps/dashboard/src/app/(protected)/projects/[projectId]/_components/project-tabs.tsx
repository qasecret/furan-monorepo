"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

interface Tab {
  href: string;
  label: string;
}

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
 * (`/projects/<id>/runs/<runId>/diffs/<diffId>`) keep "Runs" active.
 */
export function ProjectTabs({ projectId }: Props) {
  const pathname = usePathname();
  const tabs: Tab[] = [
    { href: `/projects/${projectId}/builds`, label: "Builds" },
    { href: `/projects/${projectId}/runs`, label: "Runs" },
    { href: `/projects/${projectId}/settings`, label: "Settings" },
  ];

  return (
    <nav
      className="flex items-center gap-1 border-b border-zinc-800"
      data-testid="project-tabs"
    >
      {tabs.map((t) => {
        const isActive =
          pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            data-testid={`project-tab-${t.label.toLowerCase()}`}
            className={cn(
              "relative inline-flex h-10 items-center justify-center px-3 text-sm font-medium transition-colors focus-visible:outline-none",
              isActive
                ? "text-brand after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-brand"
                : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
