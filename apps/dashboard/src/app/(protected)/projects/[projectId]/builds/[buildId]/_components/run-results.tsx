"use client";

import {
  isPending,
  type RunStatus,
  type RunStatusOverride,
} from "@furan/shared-types";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  BATCH_COMMANDS,
  BATCH_LIST_ATTR,
  type BatchCtx,
} from "./batch-commands";
import {
  BatchCursorProvider,
  NO_STEPS_GROUP,
  runRowId,
  stepItemId,
  useBatchCursorChannel,
  useCursorItem,
  useReportRow,
  type RowReport,
} from "./batch-cursor-context";
import { createStepActions, StepActionsProvider } from "./step-actions-context";
import { StepCard, type StepRun } from "./step-card";

import { cn } from "@/lib/cn";
import { useCommands } from "@/lib/commands/registry";
import { useListCursor } from "@/lib/commands/use-list-cursor";
import { diffViewerHref } from "@/lib/diff-viewer-href";
import { runStatusFor } from "@/lib/review/optimistic";
import {
  useReviewMutations,
  type DecideArgs,
} from "@/lib/review/use-review-mutations";
import type { ReviewContext, StepFacets } from "@/lib/review-context";
import { statusStyle } from "@/lib/status-style";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type Checkpoint = RouterOutputs["runs"]["listCheckpoints"]["items"][number];
type RunRow = RouterOutputs["runs"]["list"]["items"][number];

/**
 * Shared 7-column grid template for the result table — the column header
 * (in batch-page) and every result row align to this so the columns line up:
 * Status · Execution Cloud · Test · Branch · OS · Browser · Viewport.
 */
export const RESULT_GRID =
  "grid items-center gap-3 grid-cols-[132px_116px_minmax(104px,1fr)_84px_72px_100px_84px]";

/** A row with no steps: one array, so the row's report does not change. */
const NO_CHECKPOINTS: Checkpoint[] = [];

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

/** Whether any environment facet is set. */
function hasFacets(facets: StepFacets): boolean {
  return (
    facets.browser !== undefined ||
    facets.viewport !== undefined ||
    facets.os !== undefined ||
    facets.device !== undefined
  );
}

/**
 * Whether a step is in the environment the facets name. The facets given
 * together hold on the same step, as they do for `runs.list` (spec §4.1); a
 * step with no OS (or no device) never matches an OS (or device) facet.
 */
function inFacets(
  step: Pick<Checkpoint, "browser" | "viewport" | "os" | "device">,
  facets: StepFacets,
): boolean {
  return (
    (facets.browser === undefined || step.browser === facets.browser) &&
    (facets.viewport === undefined || step.viewport === facets.viewport) &&
    (facets.os === undefined || step.os === facets.os) &&
    (facets.device === undefined || step.device === facets.device)
  );
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
  /**
   * The page's review context: its facets narrow the steps shown, and the
   * viewer opens with it. One object while the URL's filters stay the same.
   */
  ctx: ReviewContext;
  /**
   * The run's pending steps inside the facets, and all its steps, as the run
   * list counts them. Said by a row that has no steps of its own to count.
   */
  pendingCount?: number;
  stepCount?: number;
  /** Step layout: "list" scrolls horizontally, "grid" wraps. */
  view: "list" | "grid";
  /** Gates the per-step review actions (approve, reject, undo). */
  canReview: boolean;
  /**
   * "Back to batch" landed on this run: bring its first row to the middle of
   * the page and focus it, once. `onRevealed` says it has; it must be stable.
   */
  reveal?: boolean;
  onRevealed?: () => void;
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
  ctx,
  pendingCount = 0,
  stepCount = 0,
  view,
  canReview,
  reveal = false,
  onRevealed,
}: Props) {
  const q = trpc.runs.listCheckpoints.useQuery({ runId });
  // One review instance for the run's cards, not one per card: it subscribes
  // to every checkpoint in flight, and the rows below are memoized so that
  // only the card whose step changed is redrawn. Its functions are stable.
  const { decide, undo } = useReviewMutations();
  const items = q.data?.items;
  // The steps the facets leave. The run itself (below) is judged by all of
  // them: a facet changes what is shown, never what the run allows.
  const { facets } = ctx;
  const visible = useMemo(
    () =>
      hasFacets(facets) ? items?.filter((c) => inFacets(c, facets)) : items,
    [items, facets],
  );
  const groups = useMemo(
    () => groupByEnv(visible ?? [], fallbackStatus, statusOverride),
    [visible, fallbackStatus, statusOverride],
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
        groupKey={NO_STEPS_GROUP}
        index={0}
        os={null}
        browser="—"
        viewport="—"
        status={run.status}
        checkpoints={NO_CHECKPOINTS}
        runPending={pendingCount}
        runSteps={stepCount}
        run={run}
        ctx={ctx}
        decide={decide}
        undo={undo}
        view={view}
        canReview={canReview}
        anchorId={anchorIdOf(runId)}
        reveal={reveal}
        onRevealed={onRevealed}
      />
    );
  }

  return (
    <>
      {groups.map((g, i) => (
        <ResultRow
          key={`${runId}:${g.key}`}
          projectId={projectId}
          runId={runId}
          testName={testName}
          branchName={branchName}
          groupKey={g.key}
          index={i}
          os={g.os}
          browser={g.browser}
          viewport={g.viewport}
          status={g.status}
          checkpoints={g.checkpoints}
          runPending={pendingCount}
          runSteps={stepCount}
          run={run}
          ctx={ctx}
          decide={decide}
          undo={undo}
          view={view}
          canReview={canReview}
          // The run's anchor is on its first row only, so it stays unique
          // however many environments the run has.
          anchorId={i === 0 ? anchorIdOf(runId) : undefined}
          reveal={reveal && i === 0}
          onRevealed={onRevealed}
        />
      ))}
    </>
  );
}

/** The id "Back to batch" links to (`#run-<runId>`). */
const anchorIdOf = (runId: string): string => `run-${runId}`;

interface RowProps {
  projectId: string;
  runId: string;
  testName: string;
  branchName: string | null;
  /** The row's environment group (`NO_STEPS_GROUP` for a run without steps). */
  groupKey: string;
  /** Its place among its run's rows. */
  index: number;
  os: string | null;
  browser: string;
  viewport: string;
  status: RunStatus;
  checkpoints: Checkpoint[];
  /** The run's pending and total steps from the list: said when this row has no steps. */
  runPending: number;
  runSteps: number;
  run: StepRun;
  ctx: ReviewContext;
  decide: (args: DecideArgs) => void;
  undo: (actionId?: string) => void;
  view: "list" | "grid";
  canReview: boolean;
  /** The run's anchor id; on the run's first row only. */
  anchorId?: string | undefined;
  reveal?: boolean;
  onRevealed?: (() => void) | undefined;
}

/** Memoized, so a decision redraws the rows whose steps changed and no others. */
const ResultRow = memo(function ResultRow({
  projectId,
  runId,
  testName,
  branchName,
  groupKey,
  index,
  os,
  browser,
  viewport,
  status,
  checkpoints,
  runPending,
  runSteps,
  run,
  ctx,
  decide,
  undo,
  view,
  canReview,
  anchorId,
  reveal = false,
  onRevealed,
}: RowProps) {
  const sm = statusStyle(status);
  const hasSteps = checkpoints.length > 0;
  // A row counts its own steps, the ones the facets leave. A row with none
  // loaded says what the run list counted for the run: its pending steps
  // inside the facets, but ALL its steps, so with a facet on the two do not
  // measure the same thing and only the pending count is said.
  const pending = hasSteps
    ? checkpoints.filter((c) => c.state !== null && isPending(c.state)).length
    : runPending;
  const total = hasSteps ? checkpoints.length : runSteps;
  const pendingText =
    !hasSteps && hasFacets(ctx.facets)
      ? `${pending} pending`
      : `${pending} of ${total} pending`;
  const [open, setOpen] = useState(true);

  // Its place in the batch list's cursor: the row's own toggle is the item
  // (Enter on it toggles it, spec §4.3), and the list learns the steps it
  // shows from here.
  const rowId = runRowId(runId, groupKey);
  const item = useCursorItem(rowId);
  const stepIds = useMemo(() => checkpoints.map((c) => c.id), [checkpoints]);
  useReportRow(rowId, {
    runId,
    index,
    expandable: hasSteps,
    open: hasSteps && open,
    stepIds,
    setOpen,
  });

  // "Back to batch": once, bring this row to the middle of the page and focus
  // it. No `behavior`: the jump is instant, which also honours a reduced-motion
  // preference. Focus does not scroll a second time.
  const wrapper = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!reveal) return;
    wrapper.current?.scrollIntoView({ block: "center" });
    toggle.current?.focus({ preventScroll: true });
    onRevealed?.();
  }, [reveal, onRevealed]);

  return (
    <div
      id={anchorId}
      ref={wrapper}
      className="border-b border-edge-subtle last:border-b-0"
    >
      <button
        ref={toggle}
        type="button"
        {...item}
        data-testid={`result-row-${runId}`}
        aria-expanded={hasSteps ? open : undefined}
        onClick={() => hasSteps && setOpen((o) => !o)}
        className={cn(
          RESULT_GRID,
          // Inset: the scroll container would clip a ring drawn outside.
          "w-full px-4 py-3 text-left transition-colors focus-ring focus-visible:-outline-offset-2",
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
                {pendingText}
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
            role="list"
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
                ctx={ctx}
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

/** An item of the batch list's cursor, in walking order. */
type BatchItem =
  | { id: string; kind: "run"; rowId: string; runId: string }
  | { id: string; kind: "step"; rowId: string; stepId: string };

/**
 * The cursor's items (spec §4.3): each run in the page's order, each of its
 * rows in capture order, and a row's steps after it while it shows them.
 */
function batchItems(
  runs: readonly RunRow[],
  rows: ReadonlyMap<string, RowReport>,
): BatchItem[] {
  const byRun = new Map<string, Array<[string, RowReport]>>();
  for (const [rowId, row] of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push([rowId, row]);
    byRun.set(row.runId, list);
  }
  const items: BatchItem[] = [];
  for (const { id: runId } of runs) {
    const own = (byRun.get(runId) ?? []).sort(
      ([, a], [, b]) => a.index - b.index,
    );
    for (const [rowId, row] of own) {
      items.push({ id: rowId, kind: "run", rowId, runId });
      if (!row.open) continue;
      for (const stepId of row.stepIds) {
        items.push({ id: stepItemId(stepId), kind: "step", rowId, stepId });
      }
    }
  }
  return items;
}

interface BatchResultsProps {
  projectId: string;
  /** The runs on the page, in the order the suite ran them. */
  runs: RunRow[];
  branchName: string | null;
  ctx: ReviewContext;
  view: "list" | "grid";
  canReview: boolean;
  /** The run "Back to batch" landed on: its first row is revealed, once. */
  revealRunId: string | null;
  onRevealed: () => void;
  /** The previous filter's runs are still showing. */
  busy: boolean;
  /** What shows instead while there are no runs (loading, empty, an error). */
  children?: ReactNode;
}

/**
 * The batch page's results: one `RunResults` per run, and the keyboard
 * cursor over them (spec §4.3, §6). The cursor walks the run rows and, under
 * a row that shows them, its step cards, in capture order; `a` / `r` decide
 * the focused step through its card's own buttons' path, then the cursor
 * goes on to the next step that needs a reviewer.
 */
export function BatchResults({
  projectId,
  runs,
  branchName,
  ctx,
  view,
  canReview,
  revealRunId,
  onRevealed,
  busy,
  children,
}: BatchResultsProps) {
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  const [steps] = useState(createStepActions);
  const [rows, setRows] = useState<ReadonlyMap<string, RowReport>>(
    () => new Map(),
  );
  const reportRow = useCallback((rowId: string, row: RowReport | null) => {
    setRows((prev) => {
      if (row === null && !prev.has(rowId)) return prev;
      const next = new Map(prev);
      if (row === null) next.delete(rowId);
      else next.set(rowId, row);
      return next;
    });
  }, []);
  const items = useMemo(() => batchItems(runs, rows), [runs, rows]);
  const cursor = useListCursor({ items, listRef });
  const channel = useBatchCursorChannel(cursor.itemProps, reportRow);

  const at = items.find((i) => i.id === cursor.cursorId) ?? null;
  const atRow = at === null ? undefined : rows.get(at.rowId);

  /** The step under the cursor can be decided now (read at the key press). */
  const canDecide = () => {
    if (at?.kind !== "step") return false;
    const actions = steps.get(at.stepId);
    return actions !== undefined && actions.needsReviewer && actions.canReview;
  };

  useCommands<BatchCtx>("batch", BATCH_COMMANDS, {
    itemCount: items.length,
    next: cursor.next,
    prev: cursor.prev,
    first: cursor.first,
    last: cursor.last,
    canExpand: at?.kind === "run" && atRow?.expandable === true,
    expand: () => {
      if (at?.kind !== "run" || !atRow?.expandable) return;
      if (!atRow.open) {
        atRow.setOpen(true);
        return;
      }
      const first = atRow.stepIds[0];
      if (first !== undefined) cursor.setCursor(stepItemId(first), true);
    },
    canCollapse:
      at?.kind === "step" || (at?.kind === "run" && atRow?.open === true),
    collapse: () => {
      if (at?.kind === "step") cursor.setCursor(at.rowId, true);
      else if (at?.kind === "run" && atRow?.open) atRow.setOpen(false);
    },
    canOpen: at !== null,
    open: (key) => {
      if (at?.kind === "step") {
        steps.get(at.stepId)?.open();
      } else if (at?.kind === "run") {
        // Enter is the row's own toggle (R22); `o` and the palette open the
        // run's first step.
        if (key === "Enter") {
          if (atRow?.expandable) atRow.setOpen(!atRow.open);
        } else {
          router.push(diffViewerHref(projectId, at.runId, undefined, ctx));
        }
      }
    },
    canDecide,
    decide: (kind) => {
      if (at?.kind !== "step" || !canDecide()) return;
      const actions = steps.get(at.stepId);
      if (actions === undefined) return;
      // Read before the decision: the next step after this one, in capture
      // order, that needs a reviewer.
      const from = items.indexOf(at);
      const nextStep = items
        .slice(from + 1)
        .find(
          (i) =>
            i.kind === "step" && steps.get(i.stepId)?.needsReviewer === true,
        );
      if (kind === "approved") {
        // An older capture: Approve asks first, as the card's button does.
        // Nothing is decided yet, so the cursor stays, and the question's
        // Cancel gives focus back to this card.
        const asks = actions.asksFirst;
        actions.approve();
        if (asks) return;
      } else {
        actions.reject();
      }
      // On, with focus, so the next `a` / `r` works at once. A refusal does
      // not bring it back: the toast says what happened (spec §4.3).
      if (nextStep !== undefined) cursor.setCursor(nextStep.id, true);
    },
  });

  return (
    <StepActionsProvider value={steps}>
      <BatchCursorProvider value={channel}>
        {runs.length === 0 ? (
          children
        ) : (
          <div
            ref={listRef}
            {...{ [BATCH_LIST_ATTR]: "" }}
            data-testid="batch-results"
            aria-busy={busy}
          >
            {runs.map((row) => (
              <RunResults
                key={row.id}
                projectId={projectId}
                runId={row.id}
                testName={row.name}
                branchName={branchName}
                fallbackStatus={row.status}
                statusOverride={row.statusOverride}
                ctx={ctx}
                pendingCount={row.pendingCount}
                stepCount={row.stepCount}
                view={view}
                canReview={canReview}
                reveal={row.id === revealRunId}
                onRevealed={onRevealed}
              />
            ))}
          </div>
        )}
      </BatchCursorProvider>
    </StepActionsProvider>
  );
}
