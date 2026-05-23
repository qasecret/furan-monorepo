import * as React from "react";

import { cn } from "@/lib/cn";

type Variant = "default" | "secondary" | "destructive" | "outline";

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default: "bg-zinc-900 text-zinc-300 border border-zinc-800",
  secondary: "bg-zinc-900/50 text-zinc-400 border border-zinc-800",
  destructive: "bg-red-500/10 text-red-400 border border-red-500/20",
  outline: "border border-zinc-800 text-zinc-400",
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
