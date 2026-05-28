import * as React from "react";

import { cn } from "@/lib/cn";

type Variant = "default" | "secondary" | "destructive" | "outline" | "success";

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default:
    "bg-zinc-100 text-zinc-700 border border-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800",
  secondary:
    "bg-zinc-100/70 text-zinc-600 border border-zinc-200 dark:bg-zinc-900/50 dark:text-zinc-400 dark:border-zinc-800",
  destructive:
    "bg-red-100 text-red-700 border border-red-300 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20",
  outline:
    "border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400",
  success:
    "bg-emerald-100 text-emerald-700 border border-emerald-300 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  );
}
