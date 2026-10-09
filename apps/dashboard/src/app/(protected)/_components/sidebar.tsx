"use client";

import { BarChart3, Layers, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ComponentType, useEffect, useLayoutEffect } from "react";

import { InboxBadge } from "./inbox-badge";
import { SIDEBAR_COLLAPSED_KEY, useSidebarStore } from "./use-sidebar-store";

import { cn } from "@/lib/cn";
import { isAtLeastAdmin } from "@/lib/roles";

/** Batches is the review surface — active across the inbox + the build/run pages. */
function isReviewRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/inbox") ||
    /^\/projects\/[^/]+\/(builds|runs|diffs|checkpoints)/.test(pathname)
  );
}

interface NavItemDef {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  active: (p: string) => boolean;
  badge?: boolean;
  adminOnly?: boolean;
}

const ITEMS: NavItemDef[] = [
  {
    href: "/inbox",
    label: "Batches",
    icon: Layers,
    active: isReviewRoute,
    badge: true,
  },
  {
    href: "/analytics",
    label: "Analytics",
    icon: BarChart3,
    active: (p) => p.startsWith("/analytics"),
    adminOnly: true,
  },
  {
    href: "/admin",
    label: "Admin",
    icon: ShieldCheck,
    active: (p) => p.startsWith("/admin"),
    adminOnly: true,
  },
];

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      href="/inbox"
      aria-label="Furan home"
      data-testid="sidebar-logo"
      className={cn(
        "flex items-center transition-opacity hover:opacity-80",
        collapsed ? "justify-center" : "gap-2",
      )}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand">
        <span className="h-2.5 w-2.5 rounded-sm bg-black" />
      </span>
      {!collapsed && (
        <span className="text-lg font-semibold tracking-tight text-fg">
          Furan
        </span>
      )}
    </Link>
  );
}

function Nav({ isAdmin, collapsed }: { isAdmin: boolean; collapsed: boolean }) {
  const pathname = usePathname() ?? "";
  const close = useSidebarStore((s) => s.setOpen);
  const items = ITEMS.filter((i) => !i.adminOnly || isAdmin);
  return (
    <nav className={cn("flex flex-col gap-1", collapsed ? "p-2" : "p-3")}>
      {items.map((item, i) => {
        const active = item.active(pathname);
        const Icon = item.icon;
        const showDivider = item.adminOnly && !items[i - 1]?.adminOnly;
        return (
          <div key={item.href}>
            {showDivider &&
              (collapsed ? (
                <div className="mx-2 mb-1.5 mt-3 h-px bg-edge" />
              ) : (
                <div className="mb-1 mt-3 px-3 text-2xs font-medium uppercase tracking-wider text-fg-muted">
                  Admin
                </div>
              ))}
            <Link
              href={item.href}
              onClick={() => close(false)}
              aria-current={active ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              data-testid={`sidebar-nav-${item.label.toLowerCase()}`}
              className={cn(
                "relative flex items-center rounded-md text-sm font-medium transition-colors focus-ring",
                collapsed ? "justify-center py-2" : "gap-3 px-3 py-2",
                active
                  ? cn(
                      "bg-hover",
                      // Brand indicator: the inset bar when expanded; the
                      // collapsed rail has no bar, so its icon goes brand.
                      collapsed
                        ? "text-brand-text"
                        : "text-fg shadow-[inset_2px_0_0_0_var(--color-brand)]",
                    )
                  : "text-fg-secondary hover:bg-hover hover:text-fg",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {!collapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {item.badge && <InboxBadge />}
                </>
              )}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Left navigation sidebar (reference layout). Fixed on desktop; a hamburger
 * drawer on mobile (toggled via useSidebarStore from the TopBar). Holds the
 * Furan logo + the Batches review destination, plus Analytics/Admin for admins.
 */
export function Sidebar({ userRole }: { userRole: string }) {
  const isAdmin = isAtLeastAdmin(userRole);
  const open = useSidebarStore((s) => s.open);
  const setOpen = useSidebarStore((s) => s.setOpen);
  const collapsed = useSidebarStore((s) => s.collapsed);

  useLayoutEffect(() => {
    if (window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
      useSidebarStore.setState({ collapsed: true });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <>
      {/* Desktop: collapsible rail */}
      <aside
        data-testid="app-sidebar"
        className={cn(
          "hidden shrink-0 flex-col border-r border-edge bg-sunken transition-[width] duration-200 ease-in-out md:flex",
          collapsed ? "w-16" : "w-56",
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center border-b border-edge",
            collapsed ? "justify-center px-2" : "px-4",
          )}
        >
          <Logo collapsed={collapsed} />
        </div>

        <Nav isAdmin={isAdmin} collapsed={collapsed} />
      </aside>

      {/* Mobile: drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col border-r border-edge bg-sunken">
            <div className="flex h-14 items-center justify-between border-b border-edge px-4">
              <Logo collapsed={false} />
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-fg-secondary hover:bg-hover focus-ring"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <Nav isAdmin={isAdmin} collapsed={false} />
          </aside>
        </div>
      )}
    </>
  );
}
