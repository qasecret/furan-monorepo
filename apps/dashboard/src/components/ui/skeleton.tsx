import * as React from "react";

import { cn } from "@/lib/cn";

/** Loading placeholder. Size it with className (e.g. `h-4 w-24`). */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
