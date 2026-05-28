"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type BaselineSource = "this_branch" | "parent_pr" | "default_branch";

const LABELS: Record<
  BaselineSource,
  { text: string; className: string; tooltip: string }
> = {
  this_branch: {
    text: "this branch",
    className:
      "bg-green-100 text-green-900 border-green-300 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20",
    tooltip: "Baseline comes from the same branch as this run.",
  },
  parent_pr: {
    text: "parent PR",
    className:
      "bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/20",
    tooltip:
      "No baseline on this branch yet — using the parent PR's base branch baseline.",
  },
  default_branch: {
    text: "default branch",
    className:
      "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-800",
    tooltip:
      "No branch-scoped baseline found — using the project's default branch baseline.",
  },
};

export function BaselineSourceBadge({
  source,
}: {
  source: BaselineSource | string | null | undefined;
}) {
  if (!source) return null;
  const entry = LABELS[source as BaselineSource];
  if (!entry) return null;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={`Baseline source: ${entry.text}`}>
            <Badge
              variant="outline"
              className={entry.className}
              data-baseline-source={source}
            >
              {entry.text}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>{entry.tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
