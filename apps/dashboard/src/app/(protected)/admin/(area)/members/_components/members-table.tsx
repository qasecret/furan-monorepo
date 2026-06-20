"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { AssignProjectsDialog } from "./assign-projects-dialog";
import { ChangeRoleCell } from "./change-role-cell";
import { CreateUserDialog } from "./create-user-dialog";
import { DeactivateButton } from "./deactivate-button";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface MemberRow {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: "admin" | "editor" | "guest";
  isActive: boolean;
  defaultProjectId?: string | null;
}

interface MembersTableProps {
  initialUsers: MemberRow[];
  currentUserId: string;
  /** All projects in the install — drives the per-user assign-projects dialog. */
  allProjects: { id: string; name: string }[];
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
  allProjects,
  onSearch,
}: MembersTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQ = searchParams?.get("q") ?? "";
  const [search, setSearch] = useState(initialQ);
  const [, startTransition] = useTransition();
  const firstRender = useRef(true);
  const projectNameById = new Map(allProjects.map((p) => [p.id, p.name]));

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
      <Table data-testid="members-table">
        <TableHeader>
          <tr>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {initialUsers.length === 0 ? (
            <TableEmpty colSpan={4} data-testid="members-empty">
              No users found.
            </TableEmpty>
          ) : (
            initialUsers.map((u) => (
              <TableRow key={u.id} data-testid={`user-row-${u.id}`}>
                <TableCell>
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
                  {u.defaultProjectId &&
                    projectNameById.has(u.defaultProjectId) && (
                      <div className="text-xs text-zinc-500 dark:text-zinc-500">
                        default: {projectNameById.get(u.defaultProjectId)}
                      </div>
                    )}
                </TableCell>
                <TableCell>
                  <ChangeRoleCell
                    userId={u.id}
                    value={u.role}
                    onChanged={() => router.refresh()}
                  />
                </TableCell>
                <TableCell>
                  {u.isActive ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="secondary">Disabled</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <AssignProjectsDialog
                      userId={u.id}
                      userEmail={u.email}
                      defaultProjectId={u.defaultProjectId ?? null}
                      allProjects={allProjects}
                    />
                    <DeactivateButton
                      userId={u.id}
                      isActive={u.isActive}
                      isSelf={u.id === currentUserId}
                      onChanged={() => router.refresh()}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
