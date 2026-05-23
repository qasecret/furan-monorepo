"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";

import { cn } from "@/lib/cn";

interface Props {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  href: string;
}

/**
 * Sidebar link with active-state styling. Active matches when the current
 * path starts with `href` so deep routes (e.g. `/projects/<id>/runs`)
 * still highlight the "Projects" entry.
 */
export function SidebarNavItem({ icon: Icon, label, href }: Props) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      data-testid={`sidebar-nav-${href.replace(/\//g, "-")}`}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-zinc-900 text-brand border-l-2 border-brand pl-[10px] -ml-px"
          : "text-zinc-400 hover:text-white hover:bg-zinc-900/50",
      )}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}
