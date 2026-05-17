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
      <table
        className="w-full text-sm border-collapse"
        data-testid="members-table"
      >
        <thead className="text-left text-muted-foreground border-b">
          <tr>
            <th className="py-2 pr-2">Email</th>
            <th className="py-2 pr-2">Role</th>
            <th className="py-2 pr-2">Status</th>
            <th className="py-2 pr-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {initialUsers.length === 0 ? (
            <tr>
              <td
                colSpan={4}
                className="py-6 text-center text-muted-foreground"
                data-testid="members-empty"
              >
                No users found.
              </td>
            </tr>
          ) : (
            initialUsers.map((u) => (
              <tr
                key={u.id}
                className="border-b last:border-0"
                data-testid={`user-row-${u.id}`}
              >
                <td className="py-2 pr-2">
                  <span className="font-medium">{u.email}</span>
                  {u.id === currentUserId && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (you)
                    </span>
                  )}
                  {(u.firstName || u.lastName) && (
                    <div className="text-xs text-muted-foreground">
                      {[u.firstName, u.lastName].filter(Boolean).join(" ")}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-2">
                  <ChangeRoleCell
                    userId={u.id}
                    value={u.role}
                    onChanged={() => router.refresh()}
                  />
                </td>
                <td className="py-2 pr-2">
                  {u.isActive ? (
                    <Badge>Active</Badge>
                  ) : (
                    <Badge variant="secondary">Disabled</Badge>
                  )}
                </td>
                <td className="py-2 pr-2 text-right">
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
  );
}
