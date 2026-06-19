import * as React from "react";

import { cn } from "@/lib/cn";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** Centered empty/zero-data state: optional icon, title, description, action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center dark:border-zinc-800 dark:bg-zinc-950/50",
        className,
      )}
      data-testid="empty-state"
    >
      {icon ? (
        <div className="text-zinc-400 dark:text-zinc-500" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="font-medium text-zinc-950 dark:text-white">{title}</p>
      {description ? (
        <div className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
