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
      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm" data-testid="project-members-table">
          <thead className="bg-zinc-100/70 border-b border-zinc-200 text-zinc-600 text-left dark:bg-zinc-900/50 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Email</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Added</th>
              <th className="px-4 py-2.5 font-medium text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {members.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-500"
                >
                  No members yet. Add one above.
                </td>
              </tr>
            ) : (
              members.map((m) => (
                <tr
                  key={m.id}
                  className="hover:bg-zinc-100/60 transition-colors dark:hover:bg-zinc-900/30"
                  data-testid={`member-row-${m.userId}`}
                >
                  <td className="px-4 py-2.5">{m.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant="secondary">{m.role}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-500">
                    {new Date(m.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
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
    </div>
  );
}
