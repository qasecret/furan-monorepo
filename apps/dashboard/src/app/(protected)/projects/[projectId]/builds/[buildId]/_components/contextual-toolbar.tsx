"use client";

import {
  CheckCheck,
  LayoutGrid,
  List,
  ListFilter,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";

export type Chip = "needs-review" | "all" | "passed";
export type ResultView = "list" | "grid";

const CHIP_LABEL: Record<Chip, string> = {
  "needs-review": "Needs review",
  all: "All",
  passed: "Passed",
};

interface Props {
  chip: Chip;
  onChipChange: (c: Chip) => void;
  view: ResultView;
  onViewChange: (v: ResultView) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  canApproveAll: boolean;
  onApproveAll: () => void;
  isApproving: boolean;
}

/** A labelled toolbar segment — uppercase micro-label over its controls. */
function Segment({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium uppercase tracking-wider text-fg-muted">
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function IconButton({
  active,
  label,
  onClick,
  testId,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors focus-ring",
        active
          ? "border-brand/40 bg-brand/10 text-brand-text"
          : "border-transparent text-fg-muted hover:bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="h-8 w-px self-end bg-edge" />;
}

/**
 * Segmented action toolbar above the result table — mirrors the reference's
 * uppercase-labelled icon groups: View (list / grid), Test Results (refresh +
 * filter), and the bulk-approve maintenance action.
 */
export function ContextualToolbar({
  chip,
  onChipChange,
  view,
  onViewChange,
  onRefresh,
  isRefreshing,
  canApproveAll,
  onApproveAll,
  isApproving,
}: Props) {
  return (
    <div className="flex flex-wrap items-end gap-4 border-b border-edge px-4 py-2">
      <Segment label="View">
        <IconButton
          active={view === "list"}
          label="List view"
          testId="batch-view-list"
          onClick={() => onViewChange("list")}
        >
          <List className="h-4 w-4" aria-hidden />
        </IconButton>
        <IconButton
          active={view === "grid"}
          label="Grid view"
          testId="batch-view-grid"
          onClick={() => onViewChange("grid")}
        >
          <LayoutGrid className="h-4 w-4" aria-hidden />
        </IconButton>
      </Segment>

      <Divider />

      <Segment label="Test Results">
        <IconButton label="Refresh" testId="batch-refresh" onClick={onRefresh}>
          <RefreshCw
            className={cn("h-4 w-4", isRefreshing && "animate-spin")}
            aria-hidden
          />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Filter tests"
              data-testid="batch-filter-trigger"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-fg-secondary transition-colors hover:bg-hover hover:text-fg focus-ring"
            >
              <ListFilter className="h-4 w-4" aria-hidden />
              {CHIP_LABEL[chip]}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(["needs-review", "all", "passed"] as Chip[]).map((c) => (
              <DropdownMenuItem
                key={c}
                data-testid={`batch-chip-${c}`}
                onSelect={() => onChipChange(c)}
                className={cn(chip === c && "font-semibold text-brand-text")}
              >
                {CHIP_LABEL[c]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Segment>

      {canApproveAll && (
        <>
          <Divider />
          <Segment label="Maintenance">
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
          </Segment>
        </>
      )}
    </div>
  );
}
