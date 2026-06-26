"use client";

import type { RunStatus } from "@furan/shared-types";
import { Maximize2, Star, ThumbsUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useAuthedImage } from "@/hooks/use-authed-image";
import { cn } from "@/lib/cn";
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

function accentFor(s: RunStatus): string {
  return s === "failed"
    ? "bg-red-500"
    : s === "unresolved"
      ? "bg-amber-500"
      : s === "passed"
        ? "bg-emerald-500"
        : s === "running"
          ? "bg-blue-500"
          : s === "new"
            ? "bg-sky-500"
            : "bg-zinc-300 dark:bg-zinc-700";
}

/**
 * A single checkpoint rendered as the reference's "test step" card — left
 * status accent, the screenshot thumbnail (loaded via the authed storage
 * proxy), a hover action toolbar (quick-approve + open), and an "n/total name"
 * label. The card opens the checkpoint in the diff viewer.
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
      <div className="relative overflow-hidden rounded-lg border border-zinc-200 bg-white transition-colors group-hover:border-brand/40 dark:border-zinc-800 dark:bg-zinc-950">
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-1",
            accentFor(checkpoint.status),
          )}
        />
        <button
          type="button"
          aria-label={`Open ${checkpoint.name}`}
          onClick={open}
          className="block aspect-video w-full cursor-pointer overflow-hidden bg-zinc-100 dark:bg-zinc-900"
        >
          {thumb ? (
            <img
              src={thumb}
              alt=""
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div className="h-full w-full bg-[repeating-linear-gradient(45deg,#e4e4e7,#e4e4e7_4px,#d4d4d8_4px,#d4d4d8_8px)] dark:bg-[repeating-linear-gradient(45deg,#18181b,#18181b_4px,#1f1f23_4px,#1f1f23_8px)]" />
          )}
        </button>
        <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 dark:border-zinc-800 dark:bg-zinc-900">
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
                className="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-emerald-600 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-emerald-400"
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
            className="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 px-0.5 text-sm">
        <Star
          className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-600"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">
          {index + 1}/{total} {checkpoint.name}
        </span>
      </div>
    </div>
  );
}
