"use client";

import type { RunStatus } from "@furan/shared-types";
import { Maximize2, Star, ThumbsUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useAuthedImage } from "@/hooks/use-authed-image";
import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status-style";
import { trpc } from "@/lib/trpc";

export interface StepCheckpoint {
  id: string;
  name: string;
  status: RunStatus;
  imageKey: string | null;
}

interface Props {
  projectId: string;
  runId: string;
  canReview: boolean;
  checkpoint: StepCheckpoint;
  index: number;
  total: number;
}

/**
 * A single checkpoint rendered as the reference's "test step" card — left
 * status accent, the screenshot thumbnail (loaded via the authed storage
 * proxy), a hover action toolbar (quick-approve + open), and an "n/total name"
 * label led by the status icon. The card opens the checkpoint in the diff
 * viewer.
 */
export function StepCard({
  projectId,
  runId,
  canReview,
  checkpoint,
  index,
  total,
}: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const thumb = useAuthedImage(checkpoint.imageKey);
  const status = statusStyle(checkpoint.status);
  const StatusIcon = status.icon;

  const approve = trpc.runs.approveCheckpoint.useMutation({
    onSuccess: () => {
      toast.success("Checkpoint approved");
      void utils.runs.listCheckpoints.invalidate({ runId });
      void utils.runs.list.invalidate();
      void utils.builds.getById.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const open = () =>
    router.push(
      `/projects/${projectId}/runs/${runId}/checkpoints/${checkpoint.id}`,
    );

  return (
    <div
      data-testid={`step-card-${checkpoint.id}`}
      className="group relative w-[320px] shrink-0"
    >
      <div className="relative overflow-hidden rounded-lg border border-edge bg-raised transition-colors group-hover:border-brand/40">
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 z-10 w-1", status.dot)}
        />
        <button
          type="button"
          aria-label={`Open ${checkpoint.name}`}
          onClick={open}
          className="block aspect-video w-full cursor-pointer overflow-hidden bg-muted"
        >
          {thumb ? (
            <img
              src={thumb}
              alt=""
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div className="h-full w-full bg-[repeating-linear-gradient(45deg,var(--edge),var(--edge)_4px,transparent_4px,transparent_8px)]" />
          )}
        </button>
        <div className="flex items-center justify-between border-t border-edge bg-sunken px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <div className="flex items-center gap-1">
            {canReview && (
              <button
                type="button"
                aria-label={`Approve ${checkpoint.name}`}
                data-testid={`step-approve-${checkpoint.id}`}
                disabled={approve.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  approve.mutate({ runId, checkpointId: checkpoint.id });
                }}
                className="rounded p-1.5 text-fg-muted transition-colors hover:bg-edge hover:text-status-passed-text focus-ring disabled:opacity-50"
              >
                <ThumbsUp className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={`Open ${checkpoint.name} in the viewer`}
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            className="rounded p-1.5 text-fg-muted transition-colors hover:bg-edge hover:text-fg focus-ring"
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 px-0.5 text-sm">
        {/* The accent bar alone can't tell aborted from unresolved (near-
            identical yellows), so the status icon names it too. */}
        <span
          title={status.tooltip}
          data-testid={`step-status-${checkpoint.id}`}
          className="inline-flex shrink-0"
        >
          <StatusIcon
            className={cn(
              "h-4 w-4",
              status.text,
              checkpoint.status === "running" && "motion-safe:animate-spin",
            )}
            aria-hidden
          />
          <span className="sr-only">{status.label}</span>
        </span>
        <Star className="h-4 w-4 shrink-0 text-edge-strong" aria-hidden />
        <span className="min-w-0 flex-1 truncate tabular-nums text-fg-secondary">
          {index + 1}/{total} {checkpoint.name}
        </span>
      </div>
    </div>
  );
}
