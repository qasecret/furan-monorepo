"use client";

import { AddMemberDialog } from "./add-member-dialog";
import { RemoveMemberButton } from "./remove-member-button";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
}

export function ProjectMembersTable({ projectId }: Props) {
  const { data, isLoading, error } = trpc.members.list.useQuery({ projectId });

  if (isLoading) {
    return (
      <div className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</div>
    );
  }
  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        Error: {error.message}
      </div>
    );
  }
  const members = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddMemberDialog projectId={projectId} />
      </div>
      <Table data-testid="project-members-table">
        <TableHeader>
          <tr>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Added</TableHead>
            <TableHead className="text-right" />
          </tr>
        </TableHeader>
        <TableBody>
          {members.length === 0 ? (
            <TableEmpty colSpan={4}>No members yet. Add one above.</TableEmpty>
          ) : (
            members.map((m) => (
              <TableRow key={m.id} data-testid={`member-row-${m.userId}`}>
                <TableCell>{m.email}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{m.role}</Badge>
                </TableCell>
                <TableCell className="text-zinc-500 dark:text-zinc-500">
                  {new Date(m.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  <RemoveMemberButton
                    projectId={projectId}
                    userId={m.userId}
                    email={m.email}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
