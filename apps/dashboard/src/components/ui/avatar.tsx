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
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-zinc-100 text-xs font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
        className,
      )}
      {...props}
      aria-hidden
    >
      {initial}
    </span>
  );
}
