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

  if (isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;

  const rows = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-3 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <h3 className="text-base font-medium text-zinc-900 dark:text-white">
          Audit Log
        </h3>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-100 px-1.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
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
                  <span className="whitespace-nowrap text-sm text-zinc-500">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">
                    {r.actorEmail ?? r.actorId ?? "system"}
                  </span>
                </TableCell>
                <TableCell>
                  <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {r.action}
                  </code>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-zinc-500">
                    {r.targetType}
                    {r.targetId ? `:${r.targetId.slice(0, 8)}` : ""}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-zinc-500">
                    {summarize(r.metadata)}
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {hasNextPage && (
        <div className="border-t border-zinc-200 px-6 py-3 dark:border-zinc-800">
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
