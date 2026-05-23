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
    return <div className="text-sm text-zinc-400">Loading…</div>;
  }
  if (error) {
    return <div className="text-sm text-red-400">Error: {error.message}</div>;
  }
  const { installations = [], projects = [] } = data ?? {};

  if (installations.length === 0) {
    return (
      <div data-testid="installations-empty" className="text-sm text-zinc-400">
        No installations yet — install the Furan GitHub App on a repo to
        populate this list.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
      <table className="w-full text-sm" data-testid="installations-table">
        <thead className="bg-zinc-900/50 border-b border-zinc-800 text-zinc-400 text-left">
          <tr>
            <th className="px-4 py-2.5 font-medium">Account</th>
            <th className="px-4 py-2.5 font-medium">Installation ID</th>
            <th className="px-4 py-2.5 font-medium">Repos</th>
            <th className="px-4 py-2.5 font-medium">Project</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {installations.map((inst) => (
            <tr
              key={inst.id}
              className="hover:bg-zinc-900/30 transition-colors"
              data-testid={`install-row-${inst.id}`}
            >
              <td className="px-4 py-2.5">{inst.accountLogin}</td>
              <td className="px-4 py-2.5">{inst.installationId}</td>
              <td className="px-4 py-2.5">{inst.repositoryIds.length}</td>
              <td className="px-4 py-2.5">
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
    </div>
  );
}
