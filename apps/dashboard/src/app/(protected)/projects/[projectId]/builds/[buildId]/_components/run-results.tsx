"use client";

import type { RunStatus } from "@furan/shared-types";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import { useMemo, useState } from "react";

import { StepCard } from "./step-card";

import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status-style";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type Checkpoint = RouterOutputs["runs"]["listCheckpoints"]["items"][number];

/**
 * Shared 7-column grid template for the result table — the column header
 * (in batch-page) and every result row align to this so the columns line up:
 * Status · Execution Cloud · Test · Branch · OS · Browser · Viewport.
 */
export const RESULT_GRID =
  "grid items-center gap-3 grid-cols-[132px_116px_minmax(104px,1fr)_84px_72px_100px_84px]";

// Worst-wins ordering so a result's env-level status reflects its most severe
// step (a single failed checkpoint makes the whole environment "failed").
const SEVERITY: RunStatus[] = [
  "failed",
  "unresolved",
  "new",
  "running",
  "passed",
  "aborted",
  "empty",
];

function aggregateStatus(checkpoints: { status: RunStatus }[]): RunStatus {
  let best: RunStatus = "empty";
  let bestRank = Infinity;
  for (const c of checkpoints) {
    const rank = SEVERITY.indexOf(c.status);
    if (rank >= 0 && rank < bestRank) {
      best = c.status;
      bestRank = rank;
    }
  }
  return best;
}

interface EnvGroup {
  key: string;
  os: string | null;
  browser: string;
  viewport: string;
  checkpoints: Checkpoint[];
  status: RunStatus;
}

/**
 * Groups a run's checkpoints by environment (os · browser · viewport). This is
 * a "one result row per environment" model: a test executed across
 * N environments produces N result rows, each carrying the checkpoints (steps)
 * captured in that environment. Furan stores environment per checkpoint
 * (ADR-038), so the grouping happens client-side here. Insertion order is
 * preserved, so rows and steps follow capture order.
 */
function groupByEnv(checkpoints: Checkpoint[]): EnvGroup[] {
  const map = new Map<string, EnvGroup>();
  for (const c of checkpoints) {
    const key = `${c.os ?? ""}|${c.browser}|${c.viewport}`;
    const existing = map.get(key);
    if (existing) {
      existing.checkpoints.push(c);
    } else {
      map.set(key, {
        key,
        os: c.os,
        browser: c.browser,
        viewport: c.viewport,
        checkpoints: [c],
        status: "empty",
      });
    }
  }
  const groups = [...map.values()];
  for (const g of groups) g.status = aggregateStatus(g.checkpoints);
  return groups;
}

interface Props {
  projectId: string;
  runId: string;
  testName: string;
  branchName: string | null;
  /** Run-level status, used when the run has no checkpoints to group yet. */
  fallbackStatus: RunStatus;
  /** Step layout: "list" scrolls horizontally, "grid" wraps. */
  view: "list" | "grid";
  /** Gates the per-step quick-approve action. */
  canReview: boolean;
}

/**
 * Renders one test (run) as one-or-more result rows — one per environment its
 * checkpoints were captured in. Each row expands to the step cards for that
 * environment.
 */
export function RunResults({
  projectId,
  runId,
  testName,
  branchName,
  fallbackStatus,
  view,
  canReview,
}: Props) {
  const q = trpc.runs.listCheckpoints.useQuery({ runId });
  const groups = useMemo(
    () => groupByEnv(q.data?.items ?? []),
    [q.data?.items],
  );

  if (q.isLoading) {
    return (
      <div className="border-b border-zinc-100 px-4 py-3.5 dark:border-zinc-900">
        <div className="h-5 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <ResultRow
        projectId={projectId}
        runId={runId}
        testName={testName}
        branchName={branchName}
        os={null}
        browser="—"
        viewport="—"
        status={fallbackStatus}
        checkpoints={[]}
        view={view}
        canReview={canReview}
      />
    );
  }

  return (
    <>
      {groups.map((g) => (
        <ResultRow
          key={`${runId}:${g.key}`}
          projectId={projectId}
          runId={runId}
          testName={testName}
          branchName={branchName}
          os={g.os}
          browser={g.browser}
          viewport={g.viewport}
          status={g.status}
          checkpoints={g.checkpoints}
          view={view}
          canReview={canReview}
        />
      ))}
    </>
  );
}

interface RowProps {
  projectId: string;
  runId: string;
  testName: string;
  branchName: string | null;
  os: string | null;
  browser: string;
  viewport: string;
  status: RunStatus;
  checkpoints: Checkpoint[];
  view: "list" | "grid";
  canReview: boolean;
}

function ResultRow({
  projectId,
  runId,
  testName,
  branchName,
  os,
  browser,
  viewport,
  status,
  checkpoints,
  view,
  canReview,
}: RowProps) {
  const sm = statusStyle(status);
  const hasSteps = checkpoints.length > 0;
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-900">
      <button
        type="button"
        data-testid={`result-row-${runId}`}
        aria-expanded={hasSteps ? open : undefined}
        onClick={() => hasSteps && setOpen((o) => !o)}
        className={cn(
          RESULT_GRID,
          "w-full px-4 py-3 text-left transition-colors",
          hasSteps && "hover:bg-zinc-50 dark:hover:bg-zinc-900/40",
        )}
      >
        <span className="flex items-center gap-1.5">
          {hasSteps ? (
            open ? (
              <ChevronDown
                className="h-4 w-4 shrink-0 text-zinc-400"
                aria-hidden
              />
            ) : (
              <ChevronRight
                className="h-4 w-4 shrink-0 text-zinc-400"
                aria-hidden
              />
            )
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span
            aria-hidden
            className={cn("h-3.5 w-1 shrink-0 rounded-full", sm.dot)}
          />
          <span className={cn("truncate text-xs font-medium", sm.text)}>
            {sm.label}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 truncate text-xs text-zinc-600 dark:text-zinc-400">
          <Server className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Self-hosted
        </span>
        <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {testName}
        </span>
        <span className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
          {branchName ?? "—"}
        </span>
        <span className="truncate text-xs text-zinc-600 dark:text-zinc-400">
          {os ?? "—"}
        </span>
        <span className="truncate text-xs text-zinc-600 dark:text-zinc-400">
          {browser}
        </span>
        <span className="truncate text-xs text-zinc-600 dark:text-zinc-400">
          {viewport}
        </span>
      </button>
      {hasSteps && open && (
        <div className="px-4 pb-4">
          <div
            className={cn(
              "rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/30",
              view === "grid"
                ? "flex flex-wrap gap-4"
                : "flex gap-4 overflow-x-auto",
            )}
          >
            {checkpoints.map((c, i) => (
              <StepCard
                key={c.id}
                projectId={projectId}
                runId={runId}
                canReview={canReview}
                index={i}
                total={checkpoints.length}
                checkpoint={{
                  id: c.id,
                  name: c.name,
                  status: c.status,
                  imageKey: c.imageKey,
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
