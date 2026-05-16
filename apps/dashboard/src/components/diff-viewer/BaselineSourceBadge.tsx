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
    className: "bg-green-100 text-green-800 border-green-300",
    tooltip: "Baseline comes from the same branch as this run.",
  },
  parent_pr: {
    text: "parent PR",
    className: "bg-yellow-100 text-yellow-800 border-yellow-300",
    tooltip:
      "No baseline on this branch yet — using the parent PR's base branch baseline.",
  },
  default_branch: {
    text: "default branch",
    className: "bg-gray-100 text-gray-800 border-gray-300",
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
