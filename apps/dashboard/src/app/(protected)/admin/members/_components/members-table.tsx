"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { ChangeRoleCell } from "./change-role-cell";
import { CreateUserDialog } from "./create-user-dialog";
import { DeactivateButton } from "./deactivate-button";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export interface MemberRow {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: "admin" | "editor" | "guest";
  isActive: boolean;
}

interface MembersTableProps {
  initialUsers: MemberRow[];
  currentUserId: string;
  /**
   * Optional onSearch callback — used by tests to assert the search URL is
   * computed correctly without mounting next/navigation router internals.
   * In production the router.push effect is the source of truth.
   */
  onSearch?: (q: string) => void;
}

export function MembersTable({
  initialUsers,
  currentUserId,
  onSearch,
}: MembersTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQ = searchParams?.get("q") ?? "";
  const [search, setSearch] = useState(initialQ);
  const [, startTransition] = useTransition();
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => {
      onSearch?.(search);
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      if (search) {
        next.set("q", search);
      } else {
        next.delete("q");
      }
      startTransition(() => {
        router.push(`?${next.toString()}`);
      });
    }, 300);
    return () => clearTimeout(timer);
    // We intentionally exclude searchParams/router/onSearch from deps so the
    // debounce only re-arms when the user actually edits the input. Listing
    // searchParams would loop on push; listing router/onSearch would re-fire
    // on every parent re-render.
  }, [search]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
          data-testid="members-search-input"
          aria-label="Search members by email"
        />
        <div className="flex-1" />
        <CreateUserDialog onCreated={() => router.refresh()} />
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm" data-testid="members-table">
          <thead className="bg-zinc-100/70 border-b border-zinc-200 text-zinc-600 text-left dark:bg-zinc-900/50 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Email</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {initialUsers.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-500"
                  data-testid="members-empty"
                >
                  No users found.
                </td>
              </tr>
            ) : (
              initialUsers.map((u) => (
                <tr
                  key={u.id}
                  className="hover:bg-zinc-100/60 transition-colors dark:hover:bg-zinc-900/30"
                  data-testid={`user-row-${u.id}`}
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{u.email}</span>
                    {u.id === currentUserId && (
                      <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-500">
                        (you)
                      </span>
                    )}
                    {(u.firstName || u.lastName) && (
                      <div className="text-xs text-zinc-500 dark:text-zinc-500">
                        {[u.firstName, u.lastName].filter(Boolean).join(" ")}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <ChangeRoleCell
                      userId={u.id}
                      value={u.role}
                      onChanged={() => router.refresh()}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    {u.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <DeactivateButton
                      userId={u.id}
                      isActive={u.isActive}
                      isSelf={u.id === currentUserId}
                      onChanged={() => router.refresh()}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
