"use client";

import { GitBranch, Share2 } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { BuildStatusBadge } from "@/components/build-status-badge";
import { Button } from "@/components/ui/button";
import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";
import type { RouterOutputs } from "@/lib/trpc";

export type BatchHeaderData = RouterOutputs["builds"]["getById"];

interface Props {
  build: BatchHeaderData;
}

/** A labelled stat in the header meta strip. */
function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {value}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  );
}

export function BatchHeader({ build }: Props) {
  // Status-colored accent bar (reference batch-detail header), derived from the
  // real run counts rather than a separate status mapping.
  const accent =
    build.failedCount > 0
      ? "bg-red-500"
      : build.unresolvedCount > 0
        ? "bg-amber-500"
        : build.passedCount > 0
          ? "bg-emerald-500"
          : "bg-zinc-400 dark:bg-zinc-600";

  const onShare = () => {
    void navigator.clipboard
      ?.writeText(window.location.href)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn’t copy link"));
  };

  const props = Object.entries(build.properties);

  return (
    <header
      id="batch-header"
      className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden
              className={cn("h-6 w-1 shrink-0 rounded-full", accent)}
            />
            <h1 className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">
              <span className="text-zinc-500 dark:text-zinc-400">
                Test results of batch:{" "}
              </span>
              {buildDisplayName(build)}
            </h1>
            <BuildStatusBadge status={build.aggregateStatus} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 pl-3">
            <Stat
              label={build.runCount === 1 ? "Test" : "Tests"}
              value={build.runCount}
            />
            {build.unresolvedCount > 0 && (
              <Stat
                label="Unresolved"
                value={
                  <span className="text-amber-600 dark:text-amber-400">
                    {build.unresolvedCount}
                  </span>
                }
              />
            )}
            {build.failedCount > 0 && (
              <Stat
                label="Failed"
                value={
                  <span className="text-red-600 dark:text-red-400">
                    {build.failedCount}
                  </span>
                }
              />
            )}
            {build.passedCount > 0 && (
              <Stat
                label="Passed"
                value={
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {build.passedCount}
                  </span>
                }
              />
            )}
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Started
              </span>
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {formatRelativeTime(build.createdAt)}
              </span>
            </div>
            {build.branchName && (
              <span className="inline-flex items-center gap-1 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                <GitBranch className="h-3.5 w-3.5" aria-hidden />
                {build.branchName}
              </span>
            )}
            {props.map(([k, v]) => (
              <span
                key={k}
                className="text-xs text-zinc-500 dark:text-zinc-400"
              >
                {k}={v}
              </span>
            ))}
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
