import { FolderKanban, Key, Puzzle, Users } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { LogoutButton } from "./logout-button";
import { SidebarNavItem } from "./sidebar-nav-item";

interface NavItem {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  href: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

interface Props {
  userRole: "admin" | "editor" | "guest";
  userEmail: string;
  userInitial: string;
}

/**
 * Server-rendered sidebar. Active-state styling lives in the client child
 * `SidebarNavItem` (it needs usePathname). The Admin section is gated on
 * the server-resolved role so non-admins never see those links in the DOM.
 */
export function Sidebar({ userRole, userEmail, userInitial }: Props) {
  const sections: NavSection[] = [
    {
      label: "Workspace",
      items: [{ icon: FolderKanban, label: "Projects", href: "/projects" }],
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
      className="w-60 border-r border-zinc-800 bg-zinc-950 flex flex-col shrink-0"
      data-testid="app-sidebar"
    >
      <div className="h-14 flex items-center px-4 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-brand rounded-sm rotate-12 flex items-center justify-center">
            <div className="w-1.5 h-1.5 bg-black rounded-full" />
          </div>
          <span className="font-semibold text-lg tracking-tight text-white">
            Furan
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
        {sections.map((section) => (
          <div key={section.label}>
            <div className="px-3 mb-1.5">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-600">
                {section.label}
              </span>
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <SidebarNavItem
                  key={item.href}
                  icon={item.icon}
                  label={item.label}
                  href={item.href}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-800 shrink-0">
        <div
          className="p-3 flex items-center gap-3"
          data-testid="sidebar-user-chip"
        >
          <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-300 shrink-0">
            {userInitial}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium text-zinc-200 truncate">
              {userEmail || "Signed in"}
            </span>
            <span className="text-xs text-zinc-500 truncate capitalize">
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
