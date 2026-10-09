import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Consistent section header: a prominent title with optional description and
 * right-aligned actions. The title is the page identity. Use it on every
 * top-level and section landing page so headers stay uniform.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex items-start justify-between gap-4", className)}
      data-testid="page-header"
    >
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-fg-secondary">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
