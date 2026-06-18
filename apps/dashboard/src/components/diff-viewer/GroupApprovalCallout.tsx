"use client";

import { useState } from "react";
import { toast } from "sonner";

import { GroupApprovalCalloutView } from "./GroupApprovalCalloutView";

import { plural } from "@/lib/format";
import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
  checkpointId?: string;
}

export function GroupApprovalCallout({ runId, checkpointId }: Props) {
  const [action, setAction] = useState<"accept" | "reject" | null>(null);
  const utils = trpc.useUtils();

  const groupQuery = trpc.runs.getCheckpointGroup.useQuery(
    { runId, checkpointId: checkpointId ?? "" },
    { enabled: !!checkpointId, staleTime: 30_000 },
  );

  // Accept-all + reject-all both span many runs; invalidate broadly so every
  // affected run's views and this callout's group query refresh.
  const invalidateAll = () => {
    void utils.runs.getById.invalidate();
    void utils.runs.listCheckpoints.invalidate();
    void utils.runs.getCheckpointGroup.invalidate();
  };

  const approveGroup = trpc.runs.approveCheckpointGroup.useMutation({
    onSuccess: (res: {
      approved: number;
      runCount: number;
      capped: boolean;
      cap: number;
    }) => {
      invalidateAll();
      toast.success(
        `Approved ${res.approved} checkpoint${plural(res.approved)} across ${res.runCount} run${plural(res.runCount)}` +
          (res.capped ? ` (capped at ${res.cap} — run again for more)` : ""),
      );
      setAction(null);
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const rejectGroup = trpc.runs.rejectCheckpointGroup.useMutation({
    onSuccess: (res: {
      rejected: number;
      runCount: number;
      capped: boolean;
      cap: number;
    }) => {
      invalidateAll();
      toast.success(
        `Rejected ${res.rejected} run${plural(res.rejected)}` +
          (res.capped ? ` (capped at ${res.cap} runs)` : ""),
      );
      setAction(null);
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const group = groupQuery.data;
  if (!checkpointId || !group || group.checkpointCount === 0) return null;

  // Distinct affected runs (first-seen order) for the confirm list.
  const runs = Array.from(
    new Map(group.checkpoints.map((c) => [c.runId, c.testName])).entries(),
  ).map(([id, testName]) => ({ id, testName }));

  // Reject is run-level and fails the seed's OWN run too, but getCheckpointGroup
  // excludes the seed checkpoint — so add the seed run unless one of the other
  // matched checkpoints already belongs to it. (The accept dialog instead says
  // "current checkpoint plus N other" and needs no adjustment.)
  const rejectRunCount =
    group.runCount + (runs.some((r) => r.id === runId) ? 0 : 1);

  const isPending =
    action === "accept"
      ? approveGroup.isPending
      : action === "reject"
        ? rejectGroup.isPending
        : false;

  return (
    <GroupApprovalCalloutView
      checkpointCount={group.checkpointCount}
      runCount={group.runCount}
      rejectRunCount={rejectRunCount}
      capped={group.capped}
      runs={runs}
      isPending={isPending}
      action={action}
      onAccept={() => setAction("accept")}
      onReject={() => setAction("reject")}
      onOpenChange={(open) => {
        if (!open) setAction(null);
      }}
      onConfirm={() => {
        if (action === "accept") approveGroup.mutate({ runId, checkpointId });
        else if (action === "reject")
          rejectGroup.mutate({ runId, checkpointId });
      }}
    />
  );
}
