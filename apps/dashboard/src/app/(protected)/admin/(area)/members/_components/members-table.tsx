"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { AssignProjectsDialog } from "./assign-projects-dialog";
import { ChangeRoleCell } from "./change-role-cell";
import { CreateUserDialog } from "./create-user-dialog";
import { DeactivateButton } from "./deactivate-button";

import { Avatar } from "@/components/ui/avatar";
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
  allProjects: { id: string; name: string }[];
  onSearch?: (q: string) => void;
}

const LABEL_CLS =
  "text-xs font-medium uppercase tracking-wider font-mono text-zinc-500 dark:text-zinc-400";

function initials(u: MemberRow): string {
  if (u.firstName && u.lastName) {
    return `${u.firstName[0]}${u.lastName[0]}`.toUpperCase();
  }
  if (u.firstName) return u.firstName[0]!.toUpperCase();
  return u.email[0]!.toUpperCase();
}

function displayName(u: MemberRow): string | null {
  const parts = [u.firstName, u.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
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
  }, [search]);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {/* Card header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-medium text-zinc-950 dark:text-white">
            Members
          </h3>
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-100 px-1.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {initialUsers.length}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Input
            placeholder="Search members…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
            data-testid="members-search-input"
            aria-label="Search members by email"
          />
          <CreateUserDialog onCreated={() => router.refresh()} />
        </div>
      </div>

      {/* Table */}
      <div>
        <Table bare data-testid="members-table">
          <TableHeader>
            <tr>
              <TableHead className={LABEL_CLS}>Member</TableHead>
              <TableHead className={LABEL_CLS}>Role</TableHead>
              <TableHead className={LABEL_CLS}>Status</TableHead>
              <TableHead className={`${LABEL_CLS} text-right`}>
                Actions
              </TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {initialUsers.length === 0 ? (
              <TableEmpty colSpan={4} data-testid="members-empty">
                No users found.
              </TableEmpty>
            ) : (
              initialUsers.map((u) => {
                const name = displayName(u);
                return (
                  <TableRow key={u.id} data-testid={`user-row-${u.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <Avatar initial={initials(u)} />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-zinc-950 ${
                              u.isActive
                                ? "bg-emerald-500"
                                : "bg-zinc-400 dark:bg-zinc-600"
                            }`}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-950 dark:text-white">
                            {name ?? u.email}
                            {u.id === currentUserId && (
                              <span className="ml-1.5 text-xs font-normal text-zinc-500">
                                (you)
                              </span>
                            )}
                          </p>
                          {name && (
                            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                              {u.email}
                            </p>
                          )}
                          {u.defaultProjectId &&
                            projectNameById.has(u.defaultProjectId) && (
                              <p className="truncate text-xs text-zinc-500 dark:text-zinc-500">
                                {projectNameById.get(u.defaultProjectId)}
                              </p>
                            )}
                        </div>
                      </div>
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
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
