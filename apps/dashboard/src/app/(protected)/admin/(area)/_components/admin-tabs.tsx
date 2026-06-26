"use client";

import { FolderOpen, Globe, KeyRound, Users, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  {
    label: "Members",
    href: "/admin/members",
    icon: Users,
  },
  {
    label: "Projects",
    href: "/admin/projects",
    icon: FolderOpen,
  },
  {
    label: "API Keys",
    href: "/admin/api-keys",
    icon: KeyRound,
  },
  {
    label: "Auto Rules",
    href: "/admin/auto-rules",
    icon: Zap,
  },
  {
    label: "Installations",
    href: "/admin/installations",
    icon: Globe,
  },
] as const;

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav className="w-52 shrink-0">
      <div className="space-y-1">
        {TABS.map((t) => {
          const active = pathname?.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-l-2 border-brand bg-zinc-100 pl-[10px] text-brand dark:bg-zinc-900"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900/50 dark:hover:text-white"
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
