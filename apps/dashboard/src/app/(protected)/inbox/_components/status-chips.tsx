"use client";

import { Filter } from "lucide-react";
import { Fragment, useId } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ReviewStatus } from "@/lib/review-url";

/**
 * The Batches chips, in order, each with the rule it filters by (spec §3.1:
 * the chips are filters, not a partition, so a batch can match several).
 */
const CHIPS: ReadonlyArray<{
  value: ReviewStatus;
  label: string;
  rule: string;
}> = [
  {
    value: "needs-review",
    label: "Needs review",
    rule: "Batches with at least one step waiting for review",
  },
  {
    value: "failed",
    label: "Failed",
    rule: "Batches with at least one failed test",
  },
  { value: "running", label: "Running", rule: "Batches still running" },
  {
    value: "passed",
    label: "Passed",
    rule: "Batches where every test passed",
  },
  { value: "all", label: "All", rule: "Every batch" },
];

function Chip({
  chip,
  active,
  onSelect,
}: {
  chip: (typeof CHIPS)[number];
  active: boolean;
  onSelect: (value: ReviewStatus) => void;
}) {
  const ruleId = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onSelect(chip.value)}
            aria-pressed={active}
            aria-describedby={ruleId}
            data-testid={`inbox-chip-${chip.value}`}
            className={cn(
              "rounded-full px-3 py-1 font-medium transition-colors focus-ring",
              active ? "bg-fg text-canvas" : "text-fg-secondary hover:bg-hover",
            )}
          >
            {chip.label}
          </button>
        </TooltipTrigger>
        <TooltipContent>{chip.rule}</TooltipContent>
      </Tooltip>
      {/* The rule for a keyboard or screen-reader user, who gets no hover. */}
      <span id={ruleId} hidden>
        {chip.rule}
      </span>
    </>
  );
}

export function StatusChips({
  value,
  onChange,
}: {
  value: ReviewStatus;
  onChange: (value: ReviewStatus) => void;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <div
        id="inbox-status-filter"
        role="group"
        aria-label="Filter batches by status"
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        <Filter className="h-4 w-4 text-fg-muted" aria-hidden />
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Status:
        </span>
        {CHIPS.map((chip) => (
          <Fragment key={chip.value}>
            <Chip
              chip={chip}
              active={chip.value === value}
              onSelect={onChange}
            />
          </Fragment>
        ))}
      </div>
    </TooltipProvider>
  );
}
