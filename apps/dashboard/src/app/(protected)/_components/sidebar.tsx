import {
  BarChart3,
  FolderKanban,
  Inbox,
  Key,
  Puzzle,
  Users,
} from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { InboxBadge } from "./inbox-badge";
import { LogoutButton } from "./logout-button";
import { SidebarNavItem } from "./sidebar-nav-item";

import { cn } from "@/lib/cn";
import { browserEnv } from "@/lib/env";

interface NavItem {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  href: string;
  badge?: ReactNode;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

interface Props {
  userRole: "admin" | "editor" | "guest";
  userEmail: string;
  userInitial: string;
  /**
   * Outer-`<aside>` className override. AppShell passes `hidden md:flex` so
   * the desktop sidebar only renders at ≥768px; the mobile drawer mounts
   * the same Sidebar with no override, letting it render full-height
   * inside the Radix Dialog Content.
   */
  className?: string;
}

/**
 * Server-rendered sidebar. Active-state styling lives in the client child
 * `SidebarNavItem` (it needs usePathname). The Admin section is gated on
 * the server-resolved role so non-admins never see those links in the DOM.
 */
export function Sidebar({
  userRole,
  userEmail,
  userInitial,
  className,
}: Props) {
  const sections: NavSection[] = [
    {
      label: "Workspace",
      items: [
        {
          icon: Inbox,
          label: "Inbox",
          href: "/inbox",
          badge: <InboxBadge />,
        },
        { icon: FolderKanban, label: "Projects", href: "/projects" },
      ],
    },
    {
      label: "Account",
      items: [{ icon: Key, label: "Tokens", href: "/account/tokens" }],
    },
  ];

  if (userRole === "admin") {
    sections.push({
      label: "Admin",
      items: [
        { icon: BarChart3, label: "Analytics", href: "/analytics" },
        { icon: Users, label: "Members", href: "/admin/members" },
        {
          icon: Puzzle,
          label: "Installations",
          href: "/admin/installations",
        },
      ],
    });
  }

  return (
    <aside
      className={cn(
        "w-60 border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 flex flex-col shrink-0",
        className,
      )}
      data-testid="app-sidebar"
    >
      <div className="h-14 flex items-center justify-between px-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 bg-brand rounded-md flex items-center justify-center shrink-0">
            <div className="w-2.5 h-2.5 bg-black rounded-sm" />
          </div>
          <span className="font-semibold text-lg tracking-tight text-zinc-950 dark:text-white">
            Furan
          </span>
        </div>
        <span
          className="px-2 py-0.5 rounded-md bg-zinc-100 text-[11px] font-medium text-zinc-600 border border-zinc-200 truncate max-w-[7.5rem] dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-800"
          data-testid="sidebar-workspace-chip"
          title={browserEnv.NEXT_PUBLIC_WORKSPACE_NAME}
        >
          {browserEnv.NEXT_PUBLIC_WORKSPACE_NAME}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-4 px-3 space-y-5">
        {sections.map((section) => (
          <div key={section.label}>
            <div className="px-2 mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                {section.label}
              </span>
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                // Pre-render the icon as JSX in the server component so
                // RSC serializes it as an element tree (svg markup) for
                // the client SidebarNavItem. Passing the bare component
                // reference (a forwardRef) across the boundary throws
                // "Functions cannot be passed directly to Client Components".
                const Icon = item.icon;
                return (
                  <SidebarNavItem
                    key={item.href}
                    icon={<Icon className="w-4 h-4 shrink-0" />}
                    label={item.label}
                    href={item.href}
                    badge={item.badge}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-800 shrink-0">
        <div
          className="p-3 flex items-center gap-3"
          data-testid="sidebar-user-chip"
        >
          <div className="w-8 h-8 rounded-md bg-zinc-100 flex items-center justify-center text-xs font-medium text-zinc-700 border border-zinc-200 shrink-0 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800">
            {userInitial}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {userEmail || "Signed in"}
            </span>
            <span className="text-[11px] text-zinc-500 truncate capitalize">
              {userRole}
            </span>
          </div>
        </div>
        <div className="px-3 pb-3">
          <LogoutButton />
        </div>
      </div>
    </aside>
  );
}
