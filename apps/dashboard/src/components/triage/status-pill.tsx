"use client";

import type { RunStatus } from "@furan/shared-types";
import {
  AlertTriangle,
  Ban,
  Check,
  Circle,
  CircleAlert,
  Loader2,
  Minus,
} from "lucide-react";

import { cn } from "@/lib/cn";

interface Props {
  status: RunStatus;
  className?: string;
}

const VARIANT: Record<
  RunStatus,
  { label: string; color: string; Icon: typeof AlertTriangle; spin?: boolean }
> = {
  passed: {
    label: "Passed",
    color:
      "bg-emerald-100 text-emerald-900 border-emerald-300 " +
      "dark:bg-emerald-400/15 dark:text-emerald-300 dark:border-emerald-500/30",
    Icon: Check,
  },
  unresolved: {
    label: "Unresolved",
    color:
      "bg-amber-100 text-amber-900 border-amber-300 " +
      "dark:bg-amber-400/15 dark:text-amber-300 dark:border-amber-500/30",
    Icon: AlertTriangle,
  },
  failed: {
    label: "Failed",
    color:
      "bg-red-100 text-red-900 border-red-300 " +
      "dark:bg-red-400/15 dark:text-red-300 dark:border-red-500/30",
    Icon: CircleAlert,
  },
  new: {
    label: "New",
    color:
      "bg-sky-100 text-sky-900 border-sky-300 " +
      "dark:bg-sky-400/15 dark:text-sky-300 dark:border-sky-500/30",
    Icon: Circle,
  },
  running: {
    label: "Running",
    color:
      "bg-blue-100 text-blue-900 border-blue-300 " +
      "dark:bg-blue-400/15 dark:text-blue-300 dark:border-blue-500/30",
    Icon: Loader2,
    spin: true,
  },
  aborted: {
    label: "Aborted",
    color:
      "bg-zinc-100 text-zinc-700 border-zinc-300 " +
      "dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700",
    Icon: Ban,
  },
  empty: {
    label: "Empty",
    color:
      "bg-zinc-100 text-zinc-700 border-zinc-300 " +
      "dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700",
    Icon: Minus,
  },
};

export function StatusPill({ status, className }: Props) {
  const variant = VARIANT[status];
  if (!variant) return null;
  const { label, color, Icon, spin } = variant;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        color,
        className,
      )}
    >
      <Icon className={cn("h-3 w-3", spin && "animate-spin")} aria-hidden />
      {label}
    </span>
  );
}
