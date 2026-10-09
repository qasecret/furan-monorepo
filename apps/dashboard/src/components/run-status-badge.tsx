"use client";

import type { RunStatus } from "@furan/shared-types";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status-style";

interface Props {
  status: RunStatus;
}

/**
 * Coloured status pill for a `test_runs.status` value, with a Radix tooltip
 * that explains what the status means. The look comes from `statusStyle`
 * (`@/lib/status-style`), the only status → style map.
 */
export function RunStatusBadge({ status }: Props) {
  const style = statusStyle(status);
  const Icon = style.icon;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`run-status-badge-${status}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
              style.pill,
            )}
          >
            <Icon
              className={cn(
                "h-3 w-3",
                status === "running" && "motion-safe:animate-spin",
              )}
              aria-hidden
            />
            {style.label}
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={4}>{style.tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
