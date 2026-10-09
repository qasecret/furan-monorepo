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
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge-strong bg-sunken p-8 text-center",
        className,
      )}
      data-testid="empty-state"
    >
      {icon ? (
        <div className="text-fg-muted/60" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="font-medium text-fg">{title}</p>
      {description ? (
        <div className="max-w-md text-sm text-fg-secondary">{description}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
