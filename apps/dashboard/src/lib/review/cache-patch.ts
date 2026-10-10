import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";

import {
  decidedBy,
  patchListedRun,
  pendingDelta,
  runStatusFor,
  withPendingDelta,
  type CheckpointItem,
  type ReviewChange,
  type ReviewFields,
  type RunsListPage,
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

/** Stops answers already on their way from landing on top of a patch. */
export async function cancelRun(
  { utils }: Caches,
  runId: string,
): Promise<void> {
  await Promise.all([
    utils.runs.listCheckpoints.cancel({ runId }),
    utils.runs.getById.cancel({ runId }),
    utils.runs.list.cancel(),
    utils.builds.getById.cancel(),
  ]);
}

/**
 * Applies `change` to the loaded caches of run `runId`: its checkpoints and
 * detail, its row on every `runs.list` page, and the pending count of its
 * build. A cache that is not loaded, or that the change does not reach, is left
 * alone. The run's status is recomputed from the new values.
 */
export function patchRun(
  { utils, queryClient }: Caches,
  runId: string,
  change: ReviewChange,
): void {
  const list = utils.runs.listCheckpoints.getData({ runId });
  const items = list && change.items(list.items);
  const nextList =
    list && items && items !== list.items ? { ...list, items } : undefined;
  if (nextList) utils.runs.listCheckpoints.setData({ runId }, nextList);

  // The run's status comes from the patched checkpoint list when that changed,
  // otherwise from the patched contexts of the run itself.
  const run = utils.runs.getById.getData({ runId });
  const patched = run && change.run(run, nextList?.items);
  const nextRun = patched !== run ? patched : undefined;
  if (nextRun) utils.runs.getById.setData({ runId }, nextRun);

  if (!nextList && !nextRun) return;

  // `runs.list` is cached once per filter and cursor: patch every page.
  let buildId = run?.buildId;
  const pages = queryClient.getQueriesData<RunsListPage>({
    queryKey: getQueryKey(trpc.runs.list),
  });
  for (const [key, page] of pages) {
    if (!page?.items) continue;
    buildId ??= page.items.find((r) => r.id === runId)?.buildId;
    const next = patchListedRun(
      page,
      runId,
      (row) =>
        nextRun?.status ??
        (nextList
          ? runStatusFor(nextList.items, row.status, row.statusOverride)
          : row.status),
    );
    if (next !== page) queryClient.setQueryData(key, next);
  }

  // Steps that stopped (or started) needing a reviewer move the build's count.
  const delta =
    list && nextList
      ? pendingDelta(list.items, nextList.items)
      : run && nextRun
        ? pendingDelta(
            Object.values(run.checkpointContexts),
            Object.values(nextRun.checkpointContexts),
          )
        : 0;
  if (delta === 0 || !buildId) return;
  const build = utils.builds.getById.getData({ buildId });
  if (build) {
    utils.builds.getById.setData({ buildId }, withPendingDelta(build, delta));
  }
}

/**
 * The state and decision of every loaded checkpoint of `runIds` that was
 * decided under `actionId`, by checkpoint id: what an undo of it would clear.
 */
export function loadedDecisions(
  { utils }: Caches,
  runIds: readonly string[],
  actionId: string,
): Map<string, ReviewFields> {
  const found = new Map<string, ReviewFields>();
  for (const runId of runIds) {
    const items = utils.runs.listCheckpoints.getData({ runId })?.items ?? [];
    const contexts = utils.runs.getById.getData({ runId })?.checkpointContexts;
    const rows = [
      ...items.map((i) => [i.id, i] as const),
      ...Object.entries(contexts ?? {}),
    ];
    for (const [id, fields] of decidedBy(rows, actionId)) {
      found.set(id, fields);
    }
  }
  return found;
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
