"use client";

import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";

// Sentinel value for "no project linked". Radix Select disallows empty
// string item values, and we want a real visible option for "unassigned"
// rather than a blank trigger when projectId is NULL.
const UNASSIGNED = "__unassigned";

export function InstallationsTable() {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.installations.list.useQuery();
  const update = trpc.installations.update.useMutation({
    onSuccess: async () => {
      toast.success("Installation updated");
      await utils.installations.list.invalidate();
    },
    onError: (e: { message: string }) => {
      toast.error(e.message || "Failed to update installation");
    },
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return (
      <div className="text-sm text-destructive">Error: {error.message}</div>
    );
  }
  const { installations = [], projects = [] } = data ?? {};

  if (installations.length === 0) {
    return (
      <div
        data-testid="installations-empty"
        className="text-sm text-muted-foreground"
      >
        No installations yet — install the Furan GitHub App on a repo to
        populate this list.
      </div>
    );
  }

  return (
    <table
      className="w-full text-sm border-collapse"
      data-testid="installations-table"
    >
      <thead className="text-left text-muted-foreground border-b">
        <tr>
          <th className="py-2 pr-4">Account</th>
          <th className="py-2 pr-4">Installation ID</th>
          <th className="py-2 pr-4">Repos</th>
          <th className="py-2">Project</th>
        </tr>
      </thead>
      <tbody>
        {installations.map((inst) => (
          <tr
            key={inst.id}
            className="border-b last:border-0"
            data-testid={`install-row-${inst.id}`}
          >
            <td className="py-2 pr-4">{inst.accountLogin}</td>
            <td className="py-2 pr-4">{inst.installationId}</td>
            <td className="py-2 pr-4">{inst.repositoryIds.length}</td>
            <td className="py-2">
              <Select
                value={inst.projectId ?? UNASSIGNED}
                onValueChange={(v) =>
                  update.mutate({
                    id: inst.id,
                    projectId: v === UNASSIGNED ? null : v,
                  })
                }
              >
                <SelectTrigger
                  data-testid={`install-project-select-${inst.id}`}
                  className="w-[260px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>(unassigned)</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
