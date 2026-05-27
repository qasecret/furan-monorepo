"use client";

import type { RunStatus } from "@furan/shared-types";
import { AlertTriangle, CircleAlert } from "lucide-react";

import { cn } from "@/lib/cn";

interface Props {
  status: RunStatus;
  className?: string;
}

const VARIANT: Partial<
  Record<
    RunStatus,
    { label: string; color: string; Icon: typeof AlertTriangle }
  >
> = {
  unresolved: {
    label: "Unresolved",
    color: "bg-amber-400/15 text-amber-300 border-amber-500/30",
    Icon: AlertTriangle,
  },
  failed: {
    label: "Failed",
    color: "bg-red-400/15 text-red-300 border-red-500/30",
    Icon: CircleAlert,
  },
};

export function StatusPill({ status, className }: Props) {
  const variant = VARIANT[status];
  if (!variant) return null;
  const { label, color, Icon } = variant;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        color,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}
