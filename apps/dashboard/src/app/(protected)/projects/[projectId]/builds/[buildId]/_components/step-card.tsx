"use client";

import type { RunStatus } from "@furan/shared-types";
import { Star } from "lucide-react";
import { useRouter } from "next/navigation";

import { StatusPill } from "@/components/triage/status-pill";
import { useAuthedImage } from "@/hooks/use-authed-image";
import { cn } from "@/lib/cn";

export interface StepCheckpoint {
  id: string;
  name: string;
  status: RunStatus;
  imageKey: string | null;
}

interface Props {
  projectId: string;
  runId: string;
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
 * proxy), and an "n/total name" label. Opens the checkpoint in the diff viewer.
 */
export function StepCard({
  projectId,
  runId,
  checkpoint,
  index,
  total,
}: Props) {
  const router = useRouter();
  const thumb = useAuthedImage(checkpoint.imageKey);
  const open = () =>
    router.push(
      `/projects/${projectId}/runs/${runId}/checkpoints/${checkpoint.id}`,
    );
  return (
    <div
      data-testid={`step-card-${checkpoint.id}`}
      role="button"
      tabIndex={0}
      aria-label={`Open ${checkpoint.name}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="group relative w-[320px] shrink-0 cursor-pointer overflow-hidden rounded-lg border border-zinc-200 bg-white transition-colors hover:border-brand/40 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-brand/40"
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 z-10 w-1",
          accentFor(checkpoint.status),
        )}
      />
      <div className="aspect-video w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <div className="h-full w-full bg-[repeating-linear-gradient(45deg,#e4e4e7,#e4e4e7_4px,#d4d4d8_4px,#d4d4d8_8px)] dark:bg-[repeating-linear-gradient(45deg,#18181b,#18181b_4px,#1f1f23_4px,#1f1f23_8px)]" />
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <Star
          className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-600"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-zinc-800 transition-colors group-hover:text-brand-text dark:text-zinc-200">
          {index + 1}/{total} {checkpoint.name}
        </span>
        <StatusPill status={checkpoint.status} />
      </div>
    </div>
  );
}
