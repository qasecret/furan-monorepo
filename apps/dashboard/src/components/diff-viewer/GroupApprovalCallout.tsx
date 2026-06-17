"use client";

import { useState } from "react";
import { toast } from "sonner";

import { GroupApprovalCalloutView } from "./GroupApprovalCalloutView";

import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
  checkpointId?: string;
  onResolved?: () => void;
}

const plural = (n: number) => (n === 1 ? "" : "s");

export function GroupApprovalCallout({
  runId,
  checkpointId,
  onResolved,
}: Props) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const groupQuery = trpc.runs.getCheckpointGroup.useQuery(
    { runId, checkpointId: checkpointId ?? "" },
    { enabled: !!checkpointId },
  );

  const approveGroup = trpc.runs.approveCheckpointGroup.useMutation({
    onSuccess: (res: {
      approved: number;
      runCount: number;
      capped: boolean;
      cap: number;
    }) => {
      void utils.runs.getById.invalidate({ runId });
      void utils.runs.listCheckpoints.invalidate({ runId });
      toast.success(
        `Approved ${res.approved} checkpoint${plural(res.approved)} across ${res.runCount} run${plural(res.runCount)}` +
          (res.capped ? ` (capped at ${res.cap} — run again for more)` : ""),
      );
      setOpen(false);
      onResolved?.();
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const group = groupQuery.data;
  if (!checkpointId || !group || group.checkpointCount === 0) return null;

  // Distinct affected runs (first-seen order) for the confirm list.
  const runs = Array.from(
    new Map(group.checkpoints.map((c) => [c.runId, c.testName])).entries(),
  ).map(([id, testName]) => ({ id, testName }));

  return (
    <GroupApprovalCalloutView
      checkpointCount={group.checkpointCount}
      runCount={group.runCount}
      capped={group.capped}
      runs={runs}
      isPending={approveGroup.isPending}
      open={open}
      onOpenChange={setOpen}
      onAcceptAll={() => approveGroup.mutate({ runId, checkpointId })}
    />
  );
}
