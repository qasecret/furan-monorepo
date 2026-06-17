"use client";

import { useEffect, useRef } from "react";

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

export interface GroupApprovalCalloutViewProps {
  checkpointCount: number;
  runCount: number;
  capped: boolean;
  runs: { id: string; testName: string }[];
  isPending: boolean;
  /** null = dialog closed; otherwise the action being confirmed. */
  action: "accept" | "reject" | null;
  onAccept: () => void;
  onReject: () => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

const plural = (n: number) => (n === 1 ? "" : "s");

export function GroupApprovalCalloutView({
  checkpointCount,
  runCount,
  capped,
  runs,
  isPending,
  action,
  onAccept,
  onReject,
  onOpenChange,
  onConfirm,
}: GroupApprovalCalloutViewProps) {
  // Restore focus to the trigger that opened the dialog when it closes
  // (we drive open via controlled state for two actions, so Radix's
  // AlertDialogTrigger focus-return doesn't apply — restore manually).
  // (Fires once on mount with action===null → ref is null → harmless no-op.)
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (action === null) lastTrigger.current?.focus();
  }, [action]);

  if (checkpointCount === 0) return null;

  const countLabel = `${checkpointCount}${capped ? "+" : ""}`;
  const isReject = action === "reject";

  return (
    <AlertDialog open={action !== null} onOpenChange={onOpenChange}>
      <div
        data-testid="group-approval-callout"
        className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
      >
        <span>
          Same change in {countLabel} other checkpoint{plural(checkpointCount)}{" "}
          across {runCount} run{plural(runCount)}
        </span>
        <Button
          variant="default"
          className="h-6 px-2 text-xs"
          data-testid="group-approval-accept-all"
          onClick={(e) => {
            lastTrigger.current = e.currentTarget;
            onAccept();
          }}
        >
          Accept all
        </Button>
        <Button
          variant="secondary"
          className="h-6 px-2 text-xs"
          data-testid="group-approval-reject-all"
          onClick={(e) => {
            lastTrigger.current = e.currentTarget;
            onReject();
          }}
        >
          Reject all
        </Button>
      </div>

      <AlertDialogContent data-testid="group-approval-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isReject
              ? "Reject this change everywhere it recurs?"
              : "Accept this change everywhere it recurs?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isReject
              ? `The ${runCount}${capped ? "+" : ""} run${plural(runCount)} showing this change will be marked failed. This fails each whole run (not just this checkpoint) — heavier than approving.`
              : `The current checkpoint plus ${countLabel} other unresolved checkpoint${plural(checkpointCount)} with the same change will be approved — each promotes its run's baseline.`}
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
            variant={isReject ? "destructive" : "default"}
            data-testid="group-approval-confirm"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending
              ? isReject
                ? "Rejecting…"
                : "Approving…"
              : isReject
                ? "Reject all"
                : "Accept all"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
