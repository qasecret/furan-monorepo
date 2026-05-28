"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

interface Props {
  /**
   * Pre-rendered icon JSX (e.g. `<FolderKanban className="w-4 h-4 shrink-0" />`).
   * Accepting ReactNode rather than `ComponentType<SVGProps>` lets the
   * parent server-component pass icons across the RSC boundary — passing
   * the bare component reference fails to serialize because lucide-react
   * icons are `forwardRef`'d (RSC can't serialize functions as prop values).
   */
  icon: ReactNode;
  label: string;
  href: string;
  /**
   * Optional badge rendered flush-right in the nav row (e.g. an unread count).
   * Must be a client-safe ReactNode — passed across the RSC boundary as
   * serialised JSX by the server-component Sidebar.
   */
  badge?: ReactNode;
}

/**
 * Sidebar link with active-state styling. Active matches when the current
 * path starts with `href` so deep routes (e.g. `/projects/<id>/runs`)
 * still highlight the "Projects" entry.
 */
export function SidebarNavItem({ icon, label, href, badge }: Props) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      data-testid={`sidebar-nav-${href.replace(/^\//, "").replace(/\//g, "-")}`}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
        isActive
          ? "bg-zinc-100 text-zinc-900 border-l-2 border-brand pl-[10px] -ml-px dark:bg-zinc-900 dark:text-brand"
          : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-900/50",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {badge}
    </Link>
  );
}
