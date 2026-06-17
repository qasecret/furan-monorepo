"use client";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export interface GroupApprovalCalloutViewProps {
  /** OTHER unresolved checkpoints sharing this change (seed excluded). */
  checkpointCount: number;
  /** Distinct runs among those other checkpoints. */
  runCount: number;
  /** True when more than the cap matched (display "N+"). */
  capped: boolean;
  /** Distinct affected runs, for the confirm list. */
  runs: { id: string; testName: string }[];
  /** Mutation in flight — disables the confirm button. */
  isPending: boolean;
  /** Controlled dialog open state (the container owns it). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired when the user confirms in the dialog. */
  onAcceptAll: () => void;
}

const plural = (n: number) => (n === 1 ? "" : "s");

export function GroupApprovalCalloutView({
  checkpointCount,
  runCount,
  capped,
  runs,
  isPending,
  open,
  onOpenChange,
  onAcceptAll,
}: GroupApprovalCalloutViewProps) {
  // Nothing to show when this change is unique to the current checkpoint.
  if (checkpointCount === 0) return null;

  const countLabel = `${checkpointCount}${capped ? "+" : ""}`;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <div
        data-testid="group-approval-callout"
        className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
      >
        <span>
          Same change in {countLabel} other checkpoint{plural(checkpointCount)}{" "}
          across {runCount} run{plural(runCount)}
        </span>
        <AlertDialogTrigger asChild>
          <Button
            variant="default"
            className="h-6 px-2 text-xs"
            data-testid="group-approval-accept-all"
          >
            Accept all
          </Button>
        </AlertDialogTrigger>
      </div>
      <AlertDialogContent data-testid="group-approval-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Accept this change everywhere it recurs?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The current checkpoint plus {countLabel} other unresolved checkpoint
            {plural(checkpointCount)} with the same change will be approved —
            each promotes its run&apos;s baseline.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Other affected runs ({runCount}):
        </p>
        <ul
          data-testid="group-approval-run-list"
          className="max-h-48 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        >
          {runs.map((r) => (
            <li key={r.id} className="truncate py-0.5">
              {r.testName}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="group-approval-cancel">
            Cancel
          </AlertDialogCancel>
          <Button
            variant="default"
            data-testid="group-approval-confirm"
            disabled={isPending}
            onClick={onAcceptAll}
          >
            {isPending ? "Approving…" : "Accept all"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
