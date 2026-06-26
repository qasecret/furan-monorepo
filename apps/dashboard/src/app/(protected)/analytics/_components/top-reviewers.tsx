"use client";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

interface Item {
  userId: string | null;
  email: string | null;
  actions: number;
}

interface Props {
  items: Item[];
  isLoading: boolean;
}

export function TopReviewers({ items, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i}>
            <Skeleton
              data-testid="reviewer-skeleton"
              className="mb-1 h-4 w-28"
            />
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return <EmptyState title="No reviewer activity in this window." />;
  }

  const max = Math.max(...items.map((i) => i.actions), 1);

  return (
    <div className="space-y-3">
      {items.map((it, idx) => {
        const label =
          it.email ??
          (it.userId == null ? "(deleted user)" : it.userId.slice(0, 8));
        const pct = Math.round((it.actions / max) * 100);
        return (
          <div key={it.userId ?? `deleted-${idx}`}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span
                className={
                  it.email
                    ? "truncate text-zinc-700 dark:text-zinc-300"
                    : "truncate italic text-zinc-500"
                }
              >
                {label}
              </span>
              <span className="ml-2 shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400 font-mono">
                {it.actions.toLocaleString()}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className={
                  idx === 0
                    ? "h-full rounded-full bg-brand-text"
                    : "h-full rounded-full bg-zinc-400 dark:bg-zinc-600"
                }
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
