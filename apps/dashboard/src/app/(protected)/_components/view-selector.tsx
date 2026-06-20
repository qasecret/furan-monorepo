"use client";

import {
  BarChart3,
  Check,
  ChevronDown,
  GitBranch,
  Inbox,
  Layers,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { useCurrentProject } from "./current-project-provider";
import { InboxBadge } from "./inbox-badge";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PROJECT_TABS = ["builds", "variations", "settings"] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];

const TAB_LABEL: Record<ProjectTab, string> = {
  builds: "Builds",
  variations: "Variations",
  settings: "Settings",
};

const TAB_ICON: Record<
  ProjectTab,
  React.FC<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>
> = {
  builds: Layers,
  variations: GitBranch,
  settings: Settings,
};

function activeView(pathname: string): string {
  if (pathname.startsWith("/inbox")) return "Inbox";
  if (pathname.startsWith("/analytics")) return "Analytics";
  if (pathname.startsWith("/admin")) return "Admin";
  if (pathname.startsWith("/account/preferences")) return "Preferences";
  if (pathname.startsWith("/account/tokens")) return "Tokens";
  if (pathname.startsWith("/account")) return "Account";
  if (pathname === "/projects") return "Projects";
  const tab = pathname.match(
    /^\/projects\/[^/]+\/(builds|variations|settings)/,
  );
  if (tab) return TAB_LABEL[tab[1] as ProjectTab];
  // The diff viewer + run/checkpoint routes are the review surface.
  if (/^\/projects\/[^/]+\/(runs|diffs|checkpoints)/.test(pathname)) {
    return "Review";
  }
  return "Menu";
}

export function ViewSelector({ userRole }: { userRole: string }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { currentProjectId, projects } = useCurrentProject();
  const isAdmin = userRole === "admin";

  const urlProject = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const targetProject = urlProject ?? currentProjectId;
  const targetName = projects.find((p) => p.id === targetProject)?.name;
  const active = activeView(pathname);
  const go = (href: string) => router.push(href);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch view"
          data-testid="view-selector-trigger"
          className="flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          <span className="max-w-[10rem] truncate">{active}</span>
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-zinc-500"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        {targetProject && (
          <>
            <DropdownMenuLabel className="truncate">
              {targetName ?? "Project"}
            </DropdownMenuLabel>
            {PROJECT_TABS.map((tab) => {
              const isActive =
                active === TAB_LABEL[tab] &&
                pathname.startsWith(`/projects/${targetProject}`);
              const Icon = TAB_ICON[tab];
              return (
                <DropdownMenuItem
                  key={tab}
                  data-testid={`view-${tab}`}
                  onSelect={() => go(`/projects/${targetProject}/${tab}`)}
                >
                  <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />
                  {TAB_LABEL[tab]}
                  {isActive && (
                    <Check
                      aria-hidden="true"
                      className="ml-auto h-3.5 w-3.5 text-brand"
                    />
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        <DropdownMenuItem
          data-testid="view-inbox"
          onSelect={() => go("/inbox")}
        >
          <Inbox aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />
          Inbox
          <InboxBadge />
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem
            data-testid="view-analytics"
            onSelect={() => go("/analytics")}
          >
            <BarChart3 aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />
            Analytics
          </DropdownMenuItem>
        )}
        {isAdmin && (
          <DropdownMenuItem
            data-testid="view-admin"
            onSelect={() => go("/admin")}
          >
            <ShieldCheck aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />
            Admin
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
