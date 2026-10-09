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
// Roles aren't statuses, so they keep their own hues rather than status
// tokens. One opaque pastel chip serves both themes: no single text shade
// reaches 4.5:1 on both a light and a dark surface, but -700/-800 on its
// -100 chip does (5.1–6.4:1) whatever the surface behind the chip.
const ROLE_STYLE: Record<ViewerRole, string> = {
  owner: "bg-amber-100 text-amber-800",
  admin: "bg-violet-100 text-violet-700",
  editor: "bg-sky-100 text-sky-700",
  guest: "bg-muted text-fg-secondary",
};

const NEON_HOVER =
  "data-[highlighted]:bg-brand/10 data-[highlighted]:text-brand-text";

export function AccountMenu({ email, initial, role }: Props) {
  const { currentProjectId } = useCurrentProject();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="rounded-md focus-ring"
          data-testid="account-menu-trigger"
        >
          <Avatar initial={initial} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Avatar initial={initial} className="h-7 w-7 shrink-0 text-2xs" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">
              {email || "Signed in"}
            </p>
            <span
              className={`mt-0.5 inline-block rounded px-1.5 py-px text-2xs font-semibold capitalize leading-tight ${ROLE_STYLE[role as ViewerRole] ?? ROLE_STYLE.guest}`}
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
                <Settings className="mr-2 h-3.5 w-3.5 text-fg-muted" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <form action={logoutAction}>
          <DropdownMenuItem
            asChild
            className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
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
