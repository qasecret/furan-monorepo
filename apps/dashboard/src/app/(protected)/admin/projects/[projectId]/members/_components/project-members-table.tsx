"use client";

import { AddMemberDialog } from "./add-member-dialog";
import { RemoveMemberButton } from "./remove-member-button";

import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
}

export function ProjectMembersTable({ projectId }: Props) {
  const { data, isLoading, error } = trpc.members.list.useQuery({ projectId });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return (
      <div className="text-sm text-destructive">Error: {error.message}</div>
    );
  }
  const members = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddMemberDialog projectId={projectId} />
      </div>
      <table
        className="w-full text-sm border-collapse"
        data-testid="project-members-table"
      >
        <thead className="text-left text-muted-foreground border-b">
          <tr>
            <th className="py-2 pr-2">Email</th>
            <th className="py-2 pr-2">Role</th>
            <th className="py-2 pr-2">Added</th>
            <th className="py-2 pr-2 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 ? (
            <tr>
              <td
                colSpan={4}
                className="py-6 text-center text-muted-foreground"
              >
                No members yet. Add one above.
              </td>
            </tr>
          ) : (
            members.map((m) => (
              <tr
                key={m.id}
                className="border-b last:border-0"
                data-testid={`member-row-${m.userId}`}
              >
                <td className="py-2 pr-2">{m.email}</td>
                <td className="py-2 pr-2">
                  <Badge variant="secondary">{m.role}</Badge>
                </td>
                <td className="py-2 pr-2 text-muted-foreground">
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
                <td className="py-2 pr-2 text-right">
                  <RemoveMemberButton
                    projectId={projectId}
                    userId={m.userId}
                    email={m.email}
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
