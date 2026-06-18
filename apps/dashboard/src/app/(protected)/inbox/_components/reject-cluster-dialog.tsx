"use client";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";

export interface RejectClusterDialogProps {
  open: boolean;
  /** Server cluster totals (may exceed runNames when the cluster spans pages). */
  runCount: number;
  buildCount: number;
  runNames: string[];
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function RejectClusterDialog({
  open,
  runCount,
  buildCount,
  runNames,
  isPending,
  onOpenChange,
  onConfirm,
}: RejectClusterDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="reject-cluster-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Reject this change across the queue?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The {runCount} run{plural(runCount)} across {buildCount} build
            {plural(buildCount)} showing this change will be marked failed. This
            fails each whole run (not just one checkpoint) and can be
            re-reviewed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Affected runs:
        </p>
        <ul
          data-testid="reject-cluster-run-list"
          className="max-h-48 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        >
          {runNames.map((name, i) => (
            <li key={i} className="truncate py-0.5">
              {name}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="reject-cluster-cancel">
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            data-testid="reject-cluster-confirm"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending ? "Rejecting…" : "Reject all"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
