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
import { roleStyle } from "@/lib/role-style";

interface Props {
  email: string;
  initial: string;
  role: string;
}

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
              className={`mt-0.5 inline-block rounded px-1.5 py-px text-2xs font-semibold capitalize leading-tight ${roleStyle(role)}`}
            >
              {role}
            </span>
          </div>
        </div>
        <DropdownMenuSeparator />
        {currentProjectId && (
          <>
            <DropdownMenuItem asChild>
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
