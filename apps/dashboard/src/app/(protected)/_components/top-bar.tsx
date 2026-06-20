"use client";

import { Bell, Menu, Search } from "lucide-react";
import { usePathname } from "next/navigation";

import { AccountMenu } from "./account-menu";
import { ProjectSelector } from "./project-selector";
import { useBreadcrumbsStore } from "./use-breadcrumbs";
import { useMobileSidebarStore } from "./use-mobile-sidebar";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { HelpButton } from "@/components/tour/help-button";
import { Breadcrumbs, type BreadcrumbCrumb } from "@/components/ui/breadcrumbs";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/**
 * App-shell top bar. The "search input" is a button that opens the cmdk
 * palette — there is no inline search; the palette is the search.
 *
 * The breadcrumb trail (the global "you are here" indicator) renders to the
 * right of the search box on ≥md viewports, fed by `useBreadcrumbsStore`
 * which each route publishes through `<SetBreadcrumbs>`. A pathname-derived
 * fallback keeps it from ever rendering blank before a route's effect runs.
 *
 * On <md viewports a hamburger button precedes the search; it opens the
 * MobileSidebar drawer via `useMobileSidebarStore`. The hamburger is
 * `md:hidden` so it never shows on desktop where the inline sidebar is
 * always visible.
 *
 * The bell renders disabled for v1.0; a real notification feed lands in
 * a later phase (see plan-roadmap §7.1).
 */
interface TopBarProps {
  email: string;
  initial: string;
  role: string;
}

export function TopBar({ email, initial, role }: TopBarProps) {
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const setMobileSidebarOpen = useMobileSidebarStore((s) => s.setOpen);

  return (
    <header
      className="h-14 border-b border-zinc-200 bg-zinc-50/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/50 flex items-center justify-between gap-3 px-4 md:px-6 shrink-0"
      data-testid="app-top-bar"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <button
          type="button"
          onClick={() => setMobileSidebarOpen(true)}
          className="md:hidden p-2 -ml-2 rounded-md text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-900/50 transition-colors shrink-0"
          data-testid="top-bar-menu"
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
        <ProjectSelector userRole={role} />
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="relative w-full md:w-72 md:shrink-0 flex items-center bg-white border border-zinc-200 rounded-md pl-9 pr-3 md:pr-16 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 hover:border-zinc-300 dark:bg-zinc-900 dark:border-zinc-800 dark:hover:text-zinc-300 dark:hover:border-zinc-700 transition-colors text-left truncate"
          data-testid="top-bar-search"
          aria-label="Open command palette"
        >
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <span className="truncate">Jump to project, settings, account…</span>
          <span className="hidden md:inline-block absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 font-mono border border-zinc-200 bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-400 rounded px-1.5 py-0.5">
            ⌘K
          </span>
        </button>
        <TopBarBreadcrumbs />
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <HelpButton />
        <ThemeToggle />
        <button
          type="button"
          disabled
          aria-disabled
          aria-label="Notifications (coming soon)"
          title="Notifications coming soon"
          className="p-2 rounded-md text-zinc-600 opacity-50 cursor-not-allowed dark:text-zinc-400"
          data-testid="top-bar-bell"
        >
          <Bell className="w-5 h-5" />
        </button>
        <AccountMenu email={email} initial={initial} role={role} />
      </div>
    </header>
  );
}

/**
 * Reads the published trail (or a pathname fallback) and renders it beside the
 * search box. Hidden on <md to keep the compact mobile bar uncluttered — the
 * page's own `<PageHeader>` carries identity there.
 */
function TopBarBreadcrumbs() {
  const items = useBreadcrumbsStore((s) => s.items);
  const setForPath = useBreadcrumbsStore((s) => s.pathname);
  const pathname = usePathname();
  // Only trust the published trail while it belongs to the current route;
  // otherwise (a page that published no trail, or an early-return error
  // branch) fall back to a pathname-derived crumb rather than showing the
  // previously-visited page's stale trail.
  const crumbs =
    items.length > 0 && setForPath === pathname
      ? items
      : fallbackCrumbs(pathname);
  if (crumbs.length === 0) return null;
  return (
    <div className="hidden min-w-0 flex-1 items-center md:flex">
      <Breadcrumbs items={crumbs} />
    </div>
  );
}

const TOP_LEVEL_LABELS: Record<string, string> = {
  inbox: "Inbox",
  projects: "Projects",
  analytics: "Analytics",
};

/**
 * Minimal first-segment → label map used only until the active route publishes
 * its real trail (project/run names can't be derived from the URL's ids).
 * `usePathname()` can return `null` (e.g. outside a router during tests), so
 * guard it.
 */
function fallbackCrumbs(pathname: string | null): BreadcrumbCrumb[] {
  if (!pathname) return [];
  const segs = pathname.split("/").filter(Boolean);
  const first = segs[0];
  if (!first) return [];
  const second = segs[1];
  if (first === "account") {
    if (second === "preferences") return [{ label: "Preferences" }];
    return [{ label: "Tokens" }];
  }
  if (first === "admin") {
    const crumbs: BreadcrumbCrumb[] = [{ label: "Admin", href: "/admin" }];
    if (second === "installations") crumbs.push({ label: "Installations" });
    else if (second === "members") crumbs.push({ label: "Members" });
    else if (second === "projects") crumbs.push({ label: "Project members" });
    return crumbs;
  }
  if (first === "projects") return [{ label: "Projects", href: "/projects" }];
  const label =
    TOP_LEVEL_LABELS[first] ?? first.charAt(0).toUpperCase() + first.slice(1);
  return [{ label }];
}
