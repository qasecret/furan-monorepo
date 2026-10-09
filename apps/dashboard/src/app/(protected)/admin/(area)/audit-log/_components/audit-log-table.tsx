"use client";

import { Button } from "@/components/ui/button";
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

function summarize(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  return Object.entries(metadata as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");
}

export function AuditLogTable() {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.auditLog.list.useInfiniteQuery(
      { limit: 50 },
      { getNextPageParam: (last) => last.nextCursor ?? undefined },
    );

  if (isLoading) return <p className="text-sm text-fg-muted">Loading…</p>;

  const rows = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="overflow-hidden rounded-lg bg-raised shadow-raised">
      <div className="flex items-center gap-3 border-b border-edge px-6 py-4">
        <h3 className="text-base font-medium text-fg">Audit Log</h3>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-hover px-1.5 text-xs font-medium tabular-nums text-fg-secondary">
          {rows.length}
        </span>
      </div>
      <Table bare>
        <TableHeader>
          <tr>
            <TableHead>When</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Details</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmpty colSpan={5}>
              No audit events yet. Privileged actions (user create / role change
              / deactivation) are recorded here.
            </TableEmpty>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <span className="whitespace-nowrap text-sm tabular-nums text-fg-muted">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-fg-secondary">
                    {r.actorEmail ?? r.actorId ?? "system"}
                  </span>
                </TableCell>
                <TableCell>
                  <code className="rounded bg-edge px-1.5 py-0.5 text-xs text-fg-secondary">
                    {r.action}
                  </code>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-sm tabular-nums text-fg-muted">
                    {r.targetType}
                    {r.targetId ? `:${r.targetId.slice(0, 8)}` : ""}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-fg-muted">
                    {summarize(r.metadata)}
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {hasNextPage && (
        <div className="border-t border-edge px-6 py-3">
          <Button
            variant="ghost"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
