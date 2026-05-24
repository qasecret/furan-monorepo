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
    className: "bg-green-500/10 text-green-400 border-green-500/20",
    tooltip: "Baseline comes from the same branch as this run.",
  },
  parent_pr: {
    text: "parent PR",
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    tooltip:
      "No baseline on this branch yet — using the parent PR's base branch baseline.",
  },
  default_branch: {
    text: "default branch",
    className: "bg-zinc-900 text-zinc-400 border-zinc-800",
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
