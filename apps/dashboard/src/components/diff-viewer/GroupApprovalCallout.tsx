"use client";

import { useState } from "react";

import { GroupApprovalCalloutView } from "./GroupApprovalCalloutView";

import { plural } from "@/lib/format";
import { useReviewMutations } from "@/lib/review/use-review-mutations";
import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
  checkpointId?: string;
}

/**
 * The offer to decide a step's whole group at once, behind a confirmation.
 * The decision itself is `useReviewMutations().decideGroup`: the server picks
 * the members, the hook toasts the result with an Undo, and it refreshes the
 * caches (this callout's group query included).
 */
export function GroupApprovalCallout({ runId, checkpointId }: Props) {
  const [action, setAction] = useState<"accept" | "reject" | null>(null);
  // The reviewer has confirmed and the call has not ended yet.
  const [confirmed, setConfirmed] = useState(false);
  const { decideGroup, isInFlight } = useReviewMutations();
  // The hook holds the step the group was built around from the call until
  // the server answers, so that is when this is busy.
  const busy = checkpointId !== undefined && isInFlight(checkpointId);

  const groupQuery = trpc.runs.getCheckpointGroup.useQuery(
    { runId, checkpointId: checkpointId ?? "" },
    { enabled: !!checkpointId, staleTime: 30_000 },
  );

  // The call has ended, one way or the other (the hook says which, in a
  // toast): the question has been answered.
  if (confirmed && !busy) {
    setConfirmed(false);
    setAction(null);
  }

  const group = groupQuery.data;
  if (!checkpointId || !group || group.checkpointCount === 0) return null;

  // Distinct affected runs (first-seen order) for the confirm list.
  const runs = Array.from(
    new Map(group.checkpoints.map((c) => [c.runId, c.testName])).entries(),
  ).map(([id, testName]) => ({ id, testName }));

  // Reject marks every run holding a member of the group as failed, the seed's
  // own run included — but getCheckpointGroup excludes the seed checkpoint, so
  // add the seed run unless one of the other matched checkpoints already
  // belongs to it. (The accept dialog instead says "current checkpoint plus N
  // other" and needs no adjustment.)
  const rejectRunCount =
    group.runCount + (runs.some((r) => r.id === runId) ? 0 : 1);

  const confirm = () => {
    if (action === null) return;
    const n = group.checkpointCount;
    const kind = action === "accept" ? "approved" : "rejected";
    decideGroup({
      runId,
      checkpointId,
      kind,
      label: `${kind === "approved" ? "Approved" : "Rejected"} ${n} similar step${plural(n)}`,
    });
    setConfirmed(true);
  };

  return (
    <GroupApprovalCalloutView
      checkpointCount={group.checkpointCount}
      runCount={group.runCount}
      rejectRunCount={rejectRunCount}
      capped={group.capped}
      runs={runs}
      isPending={action !== null && busy}
      action={action}
      onAccept={() => setAction("accept")}
      onReject={() => setAction("reject")}
      onOpenChange={(open) => {
        if (!open) {
          setAction(null);
          setConfirmed(false);
        }
      }}
      onConfirm={confirm}
    />
  );
}
