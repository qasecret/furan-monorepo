"use client";

import {
  isPending,
  type RunStatus,
  type RunStatusOverride,
} from "@furan/shared-types";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { StepCard, type StepRun } from "./step-card";

import { cn } from "@/lib/cn";
import { runStatusFor } from "@/lib/review/optimistic";
import {
  useReviewMutations,
  type DecideArgs,
} from "@/lib/review/use-review-mutations";
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
 *
 * A row's status is the run rollup of its own steps (`runStatusFor`, the rule
 * the server stores the run's status with), so a row, the run and an
 * optimistic patch all agree. `lifecycle` and `override` are the run's own.
 */
function groupByEnv(
  checkpoints: Checkpoint[],
  lifecycle: RunStatus,
  override: RunStatusOverride | null,
): EnvGroup[] {
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
  for (const g of groups) {
    g.status = runStatusFor(g.checkpoints, lifecycle, override);
  }
  return groups;
}

interface Props {
  projectId: string;
  runId: string;
  testName: string;
  branchName: string | null;
  /** The run's status as the list reports it. */
  fallbackStatus: RunStatus;
  /** The run's hand-set status, or null when it is computed. */
  statusOverride?: RunStatusOverride | null;
  /** Step layout: "list" scrolls horizontally, "grid" wraps. */
  view: "list" | "grid";
  /** Gates the per-step review actions (approve, reject, undo). */
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
  statusOverride = null,
  view,
  canReview,
}: Props) {
  const q = trpc.runs.listCheckpoints.useQuery({ runId });
  // One review instance for the run's cards, not one per card: it subscribes
  // to every checkpoint in flight, and the rows below are memoized so that
  // only the card whose step changed is redrawn. Its functions are stable.
  const { decide, undo } = useReviewMutations();
  const items = q.data?.items;
  const groups = useMemo(
    () => groupByEnv(items ?? [], fallbackStatus, statusOverride),
    [items, fallbackStatus, statusOverride],
  );
  // What every step card needs to know about the whole run, not just its row.
  // Primitives, so the object below changes only when one of them does.
  const status = runStatusFor(items ?? [], fallbackStatus, statusOverride);
  const undiffed = (items ?? []).some((i) => i.state === null);
  const run: StepRun = useMemo(
    () => ({
      status,
      statusOverride,
      undiffed,
    }),
    [status, statusOverride, undiffed],
  );

  if (q.isLoading) {
    return (
      <div className="border-b border-edge-subtle px-4 py-3.5">
        <div className="h-5 animate-pulse rounded bg-hover" />
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
        status={run.status}
        checkpoints={[]}
        run={run}
        decide={decide}
        undo={undo}
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
          run={run}
          decide={decide}
          undo={undo}
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
  run: StepRun;
  decide: (args: DecideArgs) => void;
  undo: (actionId?: string) => void;
  view: "list" | "grid";
  canReview: boolean;
}

/** Memoized, so a decision redraws the rows whose steps changed and no others. */
const ResultRow = memo(function ResultRow({
  projectId,
  runId,
  testName,
  branchName,
  os,
  browser,
  viewport,
  status,
  checkpoints,
  run,
  decide,
  undo,
  view,
  canReview,
}: RowProps) {
  const sm = statusStyle(status);
  const hasSteps = checkpoints.length > 0;
  const pending = checkpoints.filter(
    (c) => c.state !== null && isPending(c.state),
  ).length;
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-edge-subtle last:border-b-0">
      <button
        type="button"
        data-testid={`result-row-${runId}`}
        aria-expanded={hasSteps ? open : undefined}
        onClick={() => hasSteps && setOpen((o) => !o)}
        className={cn(
          RESULT_GRID,
          "w-full px-4 py-3 text-left transition-colors",
          hasSteps && "hover:bg-hover",
        )}
      >
        <span className="flex items-center gap-1.5">
          {hasSteps ? (
            open ? (
              <ChevronDown
                className="h-4 w-4 shrink-0 text-fg-muted"
                aria-hidden
              />
            ) : (
              <ChevronRight
                className="h-4 w-4 shrink-0 text-fg-muted"
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
          <span className="flex min-w-0 flex-col">
            <span className={cn("truncate text-xs font-medium", sm.text)}>
              {sm.label}
            </span>
            {pending > 0 && (
              <span
                data-testid={`result-pending-${runId}`}
                className="truncate text-2xs text-fg-muted"
              >
                {`${pending} of ${checkpoints.length} pending`}
              </span>
            )}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 truncate text-xs text-fg-secondary">
          <Server className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Self-hosted
        </span>
        <span className="truncate text-sm font-medium text-fg">{testName}</span>
        <span className="truncate font-mono text-xs text-fg-secondary">
          {branchName ?? "—"}
        </span>
        <span className="truncate text-xs text-fg-secondary">{os ?? "—"}</span>
        <span className="truncate text-xs text-fg-secondary">{browser}</span>
        <span className="truncate text-xs text-fg-secondary">{viewport}</span>
      </button>
      {hasSteps && open && (
        <div className="px-4 pb-4">
          <div
            className={cn(
              "rounded-lg border border-edge bg-sunken p-4",
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
                run={run}
                decide={decide}
                undo={undo}
                // The item itself, not a copy: a card whose step is the
                // object it was is not redrawn.
                checkpoint={c}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
