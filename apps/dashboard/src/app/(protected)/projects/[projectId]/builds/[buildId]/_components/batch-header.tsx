"use client";

import { Share2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import type { RouterOutputs } from "@/lib/trpc";

export type BatchHeaderData = RouterOutputs["builds"]["getById"];

interface Props {
  build: BatchHeaderData;
}

const STATUS_WORD: Record<string, { label: string; color: string }> = {
  passed: { label: "Passed", color: "text-emerald-600 dark:text-emerald-400" },
  unresolved: {
    label: "Unresolved",
    color: "text-amber-600 dark:text-amber-400",
  },
  failed: { label: "Failed", color: "text-red-600 dark:text-red-400" },
  running: { label: "Running", color: "text-blue-600 dark:text-blue-400" },
  aborted: { label: "Aborted", color: "text-zinc-500 dark:text-zinc-400" },
  empty: { label: "Empty", color: "text-zinc-500 dark:text-zinc-400" },
};

const ACCENT: Record<string, string> = {
  passed: "bg-emerald-500",
  unresolved: "bg-amber-500",
  failed: "bg-red-500",
  running: "bg-blue-500",
  aborted: "bg-zinc-400 dark:bg-zinc-600",
  empty: "bg-zinc-400 dark:bg-zinc-600",
};

/** Formats the created→updated span as HH:MM:SS (the reference's Duration). */
function formatDuration(startIso: string, endIso: string): string {
  let secs = Math.max(
    0,
    Math.round(
      (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000,
    ),
  );
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  secs -= m * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(secs)}`;
}

/**
 * Coerces a possibly-absent count to 0 — resilience against API/dashboard
 * version skew (the two deploy independently), where an older API image may
 * omit the newer aggregate fields rather than returning a number.
 */
function num(v: number | null | undefined): number {
  return v == null ? 0 : v;
}

/** One labelled meta group — "Tests: 1 in total | 0 unresolved | 1 new". */
function MetaGroup({ label, parts }: { label: string; parts: string[] }) {
  return (
    <span className="whitespace-nowrap text-xs">
      <span className="font-semibold text-zinc-800 dark:text-zinc-200">
        {label}:
      </span>{" "}
      <span className="text-zinc-500 dark:text-zinc-400">
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 && (
              <span className="px-1.5 text-zinc-300 dark:text-zinc-600">|</span>
            )}
            {p}
          </span>
        ))}
      </span>
    </span>
  );
}

function Bullet() {
  return (
    <span aria-hidden className="text-zinc-300 dark:text-zinc-600">
      •
    </span>
  );
}

export function BatchHeader({ build }: Props) {
  const status = STATUS_WORD[build.aggregateStatus] ?? STATUS_WORD.empty!;
  const accent = ACCENT[build.aggregateStatus] ?? ACCENT.empty!;

  const onShare = () => {
    void navigator.clipboard
      ?.writeText(window.location.href)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn’t copy link"));
  };

  return (
    <header
      id="batch-header"
      className="border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span
            aria-hidden
            className={cn("mt-0.5 h-9 w-1 shrink-0 rounded-full", accent)}
          />
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold tracking-tight">
              <span className={status.color}>{status.label}</span>
              <span className="text-zinc-950 dark:text-white">
                <span className="font-normal text-zinc-500 dark:text-zinc-400">
                  Test results of batch:{" "}
                </span>
                {buildDisplayName(build)}
              </span>
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <MetaGroup
                label="Tests"
                parts={[
                  `${build.runCount} in total`,
                  `${build.unresolvedCount} unresolved`,
                  `${num(build.newCount)} new`,
                ]}
              />
              <Bullet />
              <MetaGroup
                label="Steps"
                parts={[`${num(build.stepsTotal)} in total`]}
              />
              <Bullet />
              <MetaGroup
                label="Duration"
                parts={[formatDuration(build.createdAt, build.updatedAt)]}
              />
              <Bullet />
              <MetaGroup label="Run by" parts={[build.runByName ?? "—"]} />
            </div>
          </div>
        </div>
        <Button
          variant="secondary"
          className="h-8 gap-1.5 px-3 text-xs"
          data-testid="batch-share"
          onClick={onShare}
        >
          <Share2 className="h-3.5 w-3.5" aria-hidden />
          Share
        </Button>
      </div>
    </header>
  );
}
