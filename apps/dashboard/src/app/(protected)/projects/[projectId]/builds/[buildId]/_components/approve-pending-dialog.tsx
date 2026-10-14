"use client";

import type { ApproveBuildPreview } from "@furan/shared-types";
import { useEffect, useRef, useState, type RefObject } from "react";

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
import { useReviewMutations } from "@/lib/review/use-review-mutations";
import { trpc } from "@/lib/trpc";

const CONFLICT_NOTICE =
  "This batch changed since you opened this; review the new counts.";

const be = (n: number): string => (n === 1 ? "is" : "are");

/** The steps an approval would decide: all of them, or the first `cap`. */
const approveCount = (p: ApproveBuildPreview): number =>
  p.capped ? p.cap : p.pendingCheckpoints;

interface Props {
  buildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server approved the batch (after this has asked to close). */
  onApproved?: () => void;
  /**
   * Where focus goes when the dialog closes: the control that opens it. Without
   * one, the dialog gives focus back to whatever held it as it opened, which is
   * nothing for a click that does not focus its button.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * The question asked before every pending step of a build is approved: how
 * many there are, across how many tests, and what is left alone (spec §6.3).
 * The counts come from `review.previewApproveBuild`, read fresh each time the
 * dialog opens; the confirm names the count it showed, and the server refuses
 * with `batch_changed` if the batch moved since. That keeps the dialog open
 * with the new counts, so nothing is approved that the reviewer has not seen.
 *
 * Cancel has the initial focus (the safe answer), and closing hands focus back
 * to whatever opened the dialog. The approval, its Undo toast and its errors
 * belong to `useReviewMutations`.
 */
export function ApprovePendingDialog({
  buildId,
  open,
  onOpenChange,
  onApproved,
  returnFocusTo,
}: Props) {
  const query = trpc.review.previewApproveBuild.useQuery(
    { buildId },
    // Never a stale preview: each opening asks again. And never again while
    // it is open: a refetch on window focus would swap the counts under the
    // reviewer with no notice, and the server checks the confirmed count anyway.
    { enabled: open, staleTime: 0, refetchOnWindowFocus: false },
  );

  // The approval is out: the dialog stays until the server has answered, so a
  // late `batch_changed` is always seen.
  const [submitting, setSubmitting] = useState(false);
  // A dialog that is closed has nothing out.
  if (!open && submitting) setSubmitting(false);

  // Radix returns focus to a Trigger, and this dialog has none: the toolbar
  // opens it. So focus goes to the target it is given, else to what held focus
  // as it opened.
  const opener = useRef<HTMLElement | null>(null);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Esc and a click outside ask to close; not while the approval is out.
        if (!next && submitting) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent
        data-testid="approve-pending-dialog"
        // Not prevented: Radix still moves focus to Cancel.
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          opener.current =
            active instanceof HTMLElement && active !== document.body
              ? active
              : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocusTo?.current ?? opener.current;
          opener.current = null;
          if (target?.isConnected) target.focus();
        }}
      >
        {/* Mounted only while the dialog is, so what it remembers (a conflict,
            a call in flight) is gone by the next time it opens. */}
        <PendingBody
          buildId={buildId}
          preview={query.data}
          failed={query.isError && !query.isFetching}
          refreshing={query.isFetching}
          submitting={submitting}
          onSubmittingChange={setSubmitting}
          // The approval itself closes the dialog, past the guard above.
          onClose={() => onOpenChange(false)}
          onApproved={onApproved}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface BodyProps {
  buildId: string;
  /** What the server last said is pending; undefined until it has. */
  preview: ApproveBuildPreview | undefined;
  /** The last read of the preview failed, and none is under way. */
  failed: boolean;
  /** A read of the preview is under way. */
  refreshing: boolean;
  /** The approval is out. */
  submitting: boolean;
  onSubmittingChange: (submitting: boolean) => void;
  onClose: () => void;
  onApproved?: () => void;
}

function PendingBody({
  buildId,
  preview,
  failed,
  refreshing,
  submitting,
  onSubmittingChange,
  onClose,
  onApproved,
}: BodyProps) {
  const { approveBuild } = useReviewMutations();
  // The counts the server gave when the batch changed under the dialog; they
  // replace the preview's until the dialog closes.
  const [changed, setChanged] = useState<ApproveBuildPreview | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // After a change the counts are new: put focus back on the safe answer (once
  // the approval is no longer out, since Cancel cannot take focus before then).
  useEffect(() => {
    if (changed && !submitting) cancelRef.current?.focus();
  }, [changed, submitting]);

  // An answer from an earlier opening is never shown while a fresh one is on
  // its way, nor after the fresh one failed (React Query keeps the old data
  // through a failed refetch): those counts may be wrong by now.
  const shown = changed ?? (refreshing || failed ? undefined : preview);
  const approveN = shown ? approveCount(shown) : 0;
  const canConfirm = shown !== undefined && approveN > 0 && !submitting;

  const confirm = () => {
    if (!shown || !canConfirm) return;
    onSubmittingChange(true);
    try {
      approveBuild({
        buildId,
        // The pending count the reviewer saw, whole: the server compares it with
        // what is pending now, however many of them it will approve.
        expectedCount: shown.pendingCheckpoints,
        // What the server decided, not what was shown: steps decided elsewhere
        // meanwhile are not claimed.
        label: ({ decided, runs }) => {
          const tests = new Set(runs.map((r) => r.runId)).size;
          return `Approved ${decided.length} step${plural(decided.length)} in ${tests} test${plural(tests)}`;
        },
        onConflict: (fresh) => setChanged(fresh),
        onSuccess: () => {
          onClose();
          onApproved?.();
        },
        onSettled: () => onSubmittingChange(false),
      });
    } catch (error) {
      // The call never went out: nothing will settle it.
      onSubmittingChange(false);
      throw error;
    }
  };

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{titleOf(shown, failed)}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-1.5">{bodyOf(shown, failed)}</div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {changed && (
        // The hue is carried by the tint and edge; the text stays neutral.
        <div
          role="alert"
          data-testid="approve-pending-conflict"
          className="rounded-md border border-status-unresolved/25 bg-status-unresolved/10 px-3 py-2 text-xs text-fg"
        >
          {CONFLICT_NOTICE}
        </div>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel
          ref={cancelRef}
          data-testid="approve-pending-cancel"
          disabled={submitting}
        >
          Cancel
        </AlertDialogCancel>
        <Button
          variant="default"
          data-testid="approve-pending-confirm"
          disabled={!canConfirm}
          onClick={confirm}
        >
          {submitting
            ? "Approving…"
            : shown
              ? `Approve ${approveN} step${plural(approveN)}`
              : "Approve steps"}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

function titleOf(p: ApproveBuildPreview | undefined, failed: boolean): string {
  if (!p) return failed ? "Couldn't check the batch" : "Approve pending steps?";
  if (p.pendingCheckpoints === 0) return "Nothing left to approve";
  return `Approve ${p.pendingCheckpoints} pending step${plural(p.pendingCheckpoints)}?`;
}

function bodyOf(p: ApproveBuildPreview | undefined, failed: boolean) {
  if (!p) {
    return (
      <p>
        {failed
          ? "Couldn't check what is pending. Close this and try again."
          : "Checking what is pending…"}
      </p>
    );
  }
  if (p.pendingCheckpoints === 0) {
    return <p>No steps in this batch are pending.</p>;
  }
  return (
    <>
      <p>
        {`Across ${p.tests} test${plural(p.tests)}. Each step's screenshot becomes its baseline.`}
      </p>
      {p.rejectedLeftAsIs > 0 && (
        <p>
          {`${p.rejectedLeftAsIs} rejected step${plural(p.rejectedLeftAsIs)} ${be(p.rejectedLeftAsIs)} left as is.`}
        </p>
      )}
      {p.notReviewableTests > 0 && (
        <p>
          {`${p.notReviewableTests} test${plural(p.notReviewableTests)} ${be(p.notReviewableTests)} still running and ${be(p.notReviewableTests)} skipped.`}
        </p>
      )}
      {p.capped && (
        <p>
          {`Approves the first ${p.cap} of ${p.pendingCheckpoints}; run it again for the rest.`}
        </p>
      )}
    </>
  );
}
