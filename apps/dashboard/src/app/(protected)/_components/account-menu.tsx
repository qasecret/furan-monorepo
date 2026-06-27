"use client";

import { LogOut, Settings } from "lucide-react";
import Link from "next/link";

import { useCurrentProject } from "./current-project-provider";
import { logoutAction } from "./logout-action";

import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ViewerRole } from "@/lib/roles";

interface Props {
  email: string;
  initial: string;
  role: string;
}

// Typed by role so a new tier is a compile error here (the previous
// Record<string,…> silently fell back to the guest style for `owner`).
const ROLE_STYLE: Record<ViewerRole, string> = {
  owner: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  admin:
    "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  editor: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  guest: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const NEON_HOVER =
  "data-[highlighted]:bg-[#a8ff53]/10 data-[highlighted]:text-[#5a8a2a] dark:data-[highlighted]:bg-[#a8ff53]/10 dark:data-[highlighted]:text-[#a8ff53]";

export function AccountMenu({ email, initial, role }: Props) {
  const { currentProjectId } = useCurrentProject();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="account-menu-trigger"
        >
          <Avatar initial={initial} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Avatar initial={initial} className="h-7 w-7 shrink-0 text-[11px]" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {email || "Signed in"}
            </p>
            <span
              className={`mt-0.5 inline-block rounded px-1.5 py-px text-[10px] font-semibold capitalize leading-tight ${ROLE_STYLE[role as ViewerRole] ?? ROLE_STYLE.guest}`}
            >
              {role}
            </span>
          </div>
        </div>
        <DropdownMenuSeparator />
        {currentProjectId && (
          <>
            <DropdownMenuItem asChild className={NEON_HOVER}>
              <Link href={`/projects/${currentProjectId}/settings`}>
                <Settings className="mr-2 h-3.5 w-3.5 text-zinc-400" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <form action={logoutAction}>
          <DropdownMenuItem
            asChild
            className="text-red-600 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-700 dark:text-red-400 dark:data-[highlighted]:bg-red-950/40 dark:data-[highlighted]:text-red-300"
          >
            <button type="submit" className="w-full cursor-default text-left">
              <LogOut className="mr-2 h-3.5 w-3.5" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
