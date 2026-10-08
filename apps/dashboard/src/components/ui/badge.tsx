import * as React from "react";

import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status-style";

type Variant = "default" | "secondary" | "destructive" | "outline" | "success";

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default: "bg-muted text-fg-secondary border border-edge",
  secondary: "bg-muted/70 text-fg-secondary border border-edge",
  destructive: statusStyle("failed").pill,
  outline: "border border-edge text-fg-secondary",
  success: statusStyle("passed").pill,
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
