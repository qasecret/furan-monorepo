"use client";

import { Button } from "@/components/ui/button";

export type Chip = "needs-review" | "all" | "passed";

const CHIP_LABEL: Record<Chip, string> = {
  "needs-review": "Needs review",
  all: "All",
  passed: "Passed",
};

interface Props {
  chip: Chip;
  onChipChange: (c: Chip) => void;
  canApproveAll: boolean;
  onApproveAll: () => void;
  isApproving: boolean;
}

/** Grouped action toolbar for the batch content: Filter + Review. */
export function ContextualToolbar({
  chip,
  onChipChange,
  canApproveAll,
  onApproveAll,
  isApproving,
}: Props) {
  return (
    <div className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">
          Filter
        </span>
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
      </div>
      {canApproveAll && (
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            Review
          </span>
          <Button
            variant="secondary"
            className="h-7 px-3 text-xs"
            data-testid="batch-approve-all"
            disabled={isApproving}
            onClick={onApproveAll}
          >
            Approve all
          </Button>
        </div>
      )}
    </div>
  );
}
