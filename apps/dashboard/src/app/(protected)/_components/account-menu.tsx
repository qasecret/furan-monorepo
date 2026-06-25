"use client";

import Link from "next/link";

import { useCurrentProject } from "./current-project-provider";
import { logoutAction } from "./logout-action";

import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  email: string;
  initial: string;
  role: string;
}

/**
 * Top-bar account control: avatar trigger → email/role, the current project's
 * Settings + Variations, account Tokens, and Sign out. The sidebar carries the
 * primary destinations (Batches / Analytics / Admin); this menu is the catch-all
 * for project sub-views + account actions.
 */
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
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {email || "Signed in"}
          </p>
          <p className="text-xs capitalize text-zinc-500">{role}</p>
        </div>
        <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
        {currentProjectId && (
          <>
            <DropdownMenuItem asChild>
              <Link href={`/projects/${currentProjectId}/settings`}>
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/projects/${currentProjectId}/variations`}>
                Variations
              </Link>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem asChild>
          <Link href="/account/tokens">Tokens</Link>
        </DropdownMenuItem>
        <form action={logoutAction}>
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full cursor-default text-left">
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
