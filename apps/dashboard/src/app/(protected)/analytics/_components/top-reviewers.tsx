"use client";

import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Item {
  // null when the action's user row has been deleted (FK ON DELETE SET NULL).
  // Surfaced as "(deleted user)" so the row count reconciles with totalActions.
  userId: string | null;
  email: string | null;
  actions: number;
}

interface Props {
  items: Item[];
  isLoading: boolean;
}

function initialsOf(email: string | null): string {
  if (!email) return "·";
  return email.slice(0, 2).toUpperCase();
}

export function TopReviewers({ items, isLoading }: Props) {
  if (isLoading) {
    return (
      <Table>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton
                  data-testid="reviewer-skeleton"
                  className="h-6 w-full"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (items.length === 0) {
    return <EmptyState title="No reviewer activity in this window." />;
  }

  const max = Math.max(...items.map((i) => i.actions), 1);

  return (
    <Table>
      <TableHeader>
        <tr>
          <TableHead className="w-10">#</TableHead>
          <TableHead>Reviewer</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {items.map((it, idx) => {
          const rank = idx + 1;
          const label =
            it.email ??
            (it.userId == null ? "(deleted user)" : it.userId.slice(0, 8));
          const pct = Math.round((it.actions / max) * 100);
          return (
            <TableRow key={it.userId ?? `deleted-${idx}`}>
              <TableCell
                className={
                  rank === 1
                    ? "font-medium text-[var(--chart-approves)]"
                    : "text-zinc-500"
                }
              >
                {rank}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Avatar initial={initialsOf(it.email)} className="h-6 w-6" />
                  <span
                    className={
                      it.email
                        ? "truncate text-zinc-800 dark:text-zinc-200"
                        : "truncate italic text-zinc-500"
                    }
                  >
                    {label}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-zinc-200 sm:block dark:bg-zinc-800">
                    <div
                      className={
                        rank === 1
                          ? "h-full bg-[var(--chart-approves)]"
                          : "h-full bg-zinc-400 dark:bg-zinc-600"
                      }
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="font-medium tabular-nums text-zinc-950 dark:text-white">
                    {it.actions.toLocaleString()}
                  </span>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
