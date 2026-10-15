"use client";

import Link from "next/link";

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
import { diffViewerHref } from "@/lib/diff-viewer-href";
import type { ReviewContext } from "@/lib/review-context";

/** The warning a reviewer gets before approving a step an older run holds. */
const staleCopy = (buildName: string): string =>
  `A newer capture of this step exists in build ${buildName}. Approving here makes this older image the baseline.`;

interface CalloutProps {
  newer: {
    buildName: string;
    runId: string;
    /** The newer run's step of this variation; without it, its first step. */
    checkpointId?: string | null;
    projectId: string;
  };
  /** The viewer's review context: the link keeps the reviewer's filters. */
  context?: ReviewContext;
}

/**
 * Tells the reviewer that a later run captured this step again, so approving
 * this one would put an older image back as the baseline, and links to that
 * capture's own step. The hue is carried by the tint and border; the text
 * stays neutral.
 */
export function StaleStepCallout({ newer, context }: CalloutProps) {
  return (
    <div
      role="status"
      data-testid="stale-step-callout"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-status-unresolved/25 bg-status-unresolved/10 px-3 py-1.5 text-xs text-fg"
    >
      <span>{staleCopy(newer.buildName)}</span>
      <Link
        href={diffViewerHref(
          newer.projectId,
          newer.runId,
          newer.checkpointId ?? undefined,
          context,
        )}
        data-testid="stale-step-link"
        className="rounded-sm font-medium text-fg underline underline-offset-2 hover:text-fg-secondary focus-ring"
      >
        Open the newer capture
      </Link>
    </div>
  );
}

interface ConfirmProps {
  buildName: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The question asked before an older capture is approved. Cancel has the
 * initial focus (the safe answer), and closing it any other way is a Cancel.
 * The caller returns focus to the control that opened it.
 */
export function StaleStepConfirm({
  buildName,
  open,
  onCancel,
  onConfirm,
}: ConfirmProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="stale-step-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Approve an older capture?</AlertDialogTitle>
          <AlertDialogDescription>
            {staleCopy(buildName)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="stale-step-cancel">
            Cancel
          </AlertDialogCancel>
          <Button
            variant="default"
            data-testid="stale-step-confirm"
            onClick={onConfirm}
          >
            Approve older capture
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
