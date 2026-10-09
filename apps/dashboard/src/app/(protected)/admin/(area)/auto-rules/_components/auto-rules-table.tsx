"use client";

import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { CreateRuleDialog } from "./create-rule-dialog";

import { useCurrentProject } from "@/app/(protected)/_components/current-project-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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

/**
 * `match` is a jsonb column typed as `unknown` on the wire. Parse defensively
 * so a malformed/legacy row renders a placeholder instead of crashing the
 * whole table (a bare `as` cast would throw on a null/odd shape).
 */
function parseMatch(raw: unknown): { type: string; value: string } {
  if (raw && typeof raw === "object") {
    const m = raw as { type?: unknown; value?: unknown };
    return {
      type: typeof m.type === "string" ? m.type : "unknown",
      value: typeof m.value === "string" ? m.value : "—",
    };
  }
  return { type: "unknown", value: "—" };
}

export function AutoRulesTable() {
  const { currentProjectId } = useCurrentProject();
  const { data: rules, isLoading } = trpc.autoRules.list.useQuery(
    { projectId: currentProjectId! },
    { enabled: !!currentProjectId },
  );
  const utils = trpc.useUtils();

  const toggleMut = trpc.autoRules.toggle.useMutation({
    onSuccess: () => utils.autoRules.list.invalidate(),
    onError: (e) => toast.error(e.message || "Failed to toggle rule"),
  });

  const deleteMut = trpc.autoRules.delete.useMutation({
    onSuccess: () => {
      toast.success("Rule deleted");
      void utils.autoRules.list.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to delete rule"),
  });

  // Guard the non-null assertions below: until the active project resolves the
  // list query is disabled, so don't render the table or hand a null projectId
  // to the create dialog.
  if (!currentProjectId)
    return <p className="text-sm text-fg-muted">No project selected.</p>;
  if (isLoading) return <p className="text-sm text-fg-muted">Loading…</p>;

  return (
    <div className="overflow-hidden rounded-lg bg-raised shadow-raised">
      <div className="flex items-center justify-between border-b border-edge px-6 py-4">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-medium text-fg">Auto Rules</h3>
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-hover px-1.5 text-xs font-medium tabular-nums text-fg-secondary">
            {rules?.length ?? 0}
          </span>
        </div>
        <CreateRuleDialog
          projectId={currentProjectId}
          onCreated={() => utils.autoRules.list.invalidate()}
        />
      </div>
      <Table bare>
        <TableHeader>
          <tr>
            <TableHead>Label</TableHead>
            <TableHead>Match</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Applied</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {!rules || rules.length === 0 ? (
            <TableEmpty colSpan={6}>
              No auto rules yet. Create one to automatically resolve known UI
              changes.
            </TableEmpty>
          ) : (
            rules.map((rule) => {
              const match = parseMatch(rule.match);
              return (
                <TableRow key={rule.id}>
                  <TableCell>
                    <span className="text-sm font-medium text-fg">
                      {rule.label}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-edge px-1.5 py-0.5 text-xs text-fg-secondary">
                      {match.type}: {match.value}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        rule.action === "auto_approve" ? "success" : "default"
                      }
                    >
                      {rule.action === "auto_approve" ? "Auto Approve" : "Flag"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm tabular-nums text-fg-muted">
                      {rule.appliedCount}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(checked) =>
                        toggleMut.mutate({
                          id: rule.id,
                          enabled: checked,
                        })
                      }
                      disabled={toggleMut.isPending}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      onClick={() => deleteMut.mutate({ id: rule.id })}
                      disabled={deleteMut.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
