import * as React from "react";

import { cn } from "@/lib/cn";

interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  initial: string;
}

/** Initials chip. Decorative — wrap in a labelled control for a11y. */
export function Avatar({ initial, className, ...props }: AvatarProps) {
  return (
    <span
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-edge bg-muted text-xs font-medium text-fg-secondary",
        className,
      )}
      {...props}
      aria-hidden
    >
      {initial}
    </span>
  );
}
