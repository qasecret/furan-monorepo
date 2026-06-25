"use client";

import { CheckCheck } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";

export type Chip = "needs-review" | "all" | "passed";

const CHIP_LABEL: Record<Chip, string> = {
  "needs-review": "Needs review",
  all: "All",
  passed: "Passed",
};

interface Props {
  chip: Chip;
  onChipChange: (c: Chip) => void;
  resultCount: number;
  canApproveAll: boolean;
  onApproveAll: () => void;
  isApproving: boolean;
}

function Segment({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Segmented action toolbar above the result table — mirrors the reference's
 * "View · Test Results" toolbar. View drives the status filter; Test Results
 * shows the row count and the bulk-approve maintenance action.
 */
export function ContextualToolbar({
  chip,
  onChipChange,
  resultCount,
  canApproveAll,
  onApproveAll,
  isApproving,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
      <Segment label="View">
        {(["needs-review", "all", "passed"] as Chip[]).map((c) => (
          <Button
            key={c}
            variant={chip === c ? "default" : "secondary"}
            className="h-7 px-3 text-xs"
            data-testid={`batch-chip-${c}`}
            onClick={() => onChipChange(c)}
          >
            {CHIP_LABEL[c]}
          </Button>
        ))}
      </Segment>
      <div className="ml-auto flex items-center gap-5">
        <Segment label="Test Results">
          <span
            className="text-xs tabular-nums text-zinc-600 dark:text-zinc-400"
            data-testid="batch-result-count"
          >
            {resultCount} result{plural(resultCount)}
          </span>
        </Segment>
        {canApproveAll && (
          <Button
            variant="secondary"
            className="h-7 gap-1.5 px-3 text-xs"
            data-testid="batch-approve-all"
            disabled={isApproving}
            onClick={onApproveAll}
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden />
            Approve all
          </Button>
        )}
      </div>
    </div>
  );
}
