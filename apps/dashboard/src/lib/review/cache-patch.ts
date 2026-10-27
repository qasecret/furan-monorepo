import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";

import {
  decidedBy,
  fieldsOf,
  patchListedRun,
  pendingDelta,
  runStatusFor,
  withPendingDelta,
  type CheckpointItem,
  type ReviewChange,
  type ReviewFields,
  type RunsListPage,
  type StepDetail,
} from "./optimistic";

import { trpc } from "@/lib/trpc";

/**
 * Reading and writing the review caches. A patch is applied to the values the
 * caches hold NOW, and only touches what its change reaches, so a rollback is
 * just the inverse change applied the same way: it cannot undo anything that
 * another call patched in the meantime.
 */
export interface Caches {
  utils: ReturnType<typeof trpc.useUtils>;
  queryClient: QueryClient;
}

/** The cache key of every `runs.getStep` read of run `runId`, whatever step. */
const stepsKey = (runId: string): QueryKey =>
  getQueryKey(trpc.runs.getStep, { runId }, "query");

/** Every loaded step read of run `runId`, with its cache key. */
function loadedSteps(
  { queryClient }: Caches,
  runId: string,
): Array<[QueryKey, StepDetail]> {
  return queryClient
    .getQueriesData<StepDetail>({ queryKey: stepsKey(runId) })
    .filter((e): e is [QueryKey, StepDetail] => e[1] !== undefined);
}

/** Stops answers already on their way from landing on top of a patch. */
export async function cancelRun(
  { utils, queryClient }: Caches,
  runId: string,
): Promise<void> {
  await Promise.all([
    utils.runs.listCheckpoints.cancel({ runId }),
    utils.runs.getById.cancel({ runId }),
    queryClient.cancelQueries({ queryKey: stepsKey(runId) }),
    utils.runs.list.cancel(),
    utils.builds.getById.cancel(),
  ]);
}

/**
 * Applies `change` to the loaded caches of run `runId`: its step list and
 * every step of it read on its own, its header's status, its row on every
 * `runs.list` page, and the pending count of its build. A cache that is not
 * loaded, or that the change does not reach, is left alone. The run's status
 * is recomputed from the patched step list.
 */
export function patchRun(
  caches: Caches,
  runId: string,
  change: ReviewChange,
): void {
  const { utils, queryClient } = caches;
  const list = utils.runs.listCheckpoints.getData({ runId });
  const items = list && change.items(list.items);
  const nextList =
    list && items && items !== list.items ? { ...list, items } : undefined;
  if (nextList) utils.runs.listCheckpoints.setData({ runId }, nextList);

  // Each step read on its own (the one on screen, the neighbours fetched
  // ahead) shows the same decision as the list.
  const steps = loadedSteps(caches, runId);
  const patchedSteps = steps.map(([key, view]) => {
    const next = change.step(view);
    if (next !== view) queryClient.setQueryData(key, next);
    return next;
  });
  const stepsChanged = patchedSteps.some((v, k) => v !== steps[k]?.[1]);

  if (!nextList && !stepsChanged) return;

  // The header's status, from the patched step list: the run's own rollup.
  const run = utils.runs.getById.getData({ runId });
  const status =
    run && nextList
      ? runStatusFor(nextList.items, run.status, run.statusOverride)
      : undefined;
  if (run && status !== undefined && status !== run.status) {
    utils.runs.getById.setData({ runId }, { ...run, status });
  }

  // `runs.list` is cached once per filter and cursor: patch every page.
  let buildId = run?.buildId;
  const pages = queryClient.getQueriesData<RunsListPage>({
    queryKey: getQueryKey(trpc.runs.list),
  });
  for (const [key, page] of pages) {
    if (!page?.items) continue;
    buildId ??= page.items.find((r) => r.id === runId)?.buildId;
    const next = patchListedRun(page, runId, (row) =>
      nextList
        ? runStatusFor(nextList.items, row.status, row.statusOverride)
        : row.status,
    );
    if (next !== page) queryClient.setQueryData(key, next);
  }

  // Steps that stopped (or started) needing a reviewer move the build's count:
  // counted on the step list, else on the steps read on their own.
  const delta =
    list && nextList
      ? pendingDelta(list.items, nextList.items)
      : pendingDelta(
          steps.map(([, v]) => v.review),
          patchedSteps.map((v) => v.review),
        );
  if (delta === 0 || !buildId) return;
  const build = utils.builds.getById.getData({ buildId });
  if (build) {
    utils.builds.getById.setData({ buildId }, withPendingDelta(build, delta));
  }
}

/** The loaded step lists and step reads of `runIds`. */
function loadedViews(
  caches: Caches,
  runIds: readonly string[],
): { items: CheckpointItem[]; steps: StepDetail[] } {
  const items: CheckpointItem[] = [];
  const steps: StepDetail[] = [];
  for (const runId of runIds) {
    items.push(
      ...(caches.utils.runs.listCheckpoints.getData({ runId })?.items ?? []),
    );
    steps.push(...loadedSteps(caches, runId).map(([, v]) => v));
  }
  return { items, steps };
}

/**
 * The state and decision of every loaded step of `runIds` that was decided
 * under `actionId`, in each view of it: what an undo of it would clear.
 */
export function loadedDecisions(
  caches: Caches,
  runIds: readonly string[],
  actionId: string,
): ReviewFields {
  const { items, steps } = loadedViews(caches, runIds);
  return decidedBy(items, steps, actionId);
}

/**
 * The state and decision the loaded caches hold for the steps `ids`, decided
 * or not, in each view of them: what a decision on them would overwrite.
 */
export function loadedFields(
  caches: Caches,
  runIds: readonly string[],
  ids: ReadonlySet<string>,
): ReviewFields {
  const { items, steps } = loadedViews(caches, runIds);
  return fieldsOf(items, steps, (_decision, id) => ids.has(id));
}

const runIdOf = (key: QueryKey): string | undefined => {
  const input = (key[1] as { input?: { runId?: unknown } } | undefined)?.input;
  return typeof input?.runId === "string" ? input.runId : undefined;
};

/** The runs whose loaded checkpoint lists hold a decision made under `actionId`. */
export function runsDecidedBy(
  { queryClient }: Caches,
  actionId: string,
): string[] {
  const runIds: string[] = [];
  const lists = queryClient.getQueriesData<{ items: CheckpointItem[] }>({
    queryKey: getQueryKey(trpc.runs.listCheckpoints),
  });
  for (const [key, list] of lists) {
    const runId = runIdOf(key);
    if (runId && list?.items?.some((i) => i.decision?.actionId === actionId)) {
      runIds.push(runId);
    }
  }
  return runIds;
}
