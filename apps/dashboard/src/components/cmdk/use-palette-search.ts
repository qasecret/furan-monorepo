"use client";

import { useEffect, useMemo, useState } from "react";

import { buildDisplayName, matchesBatchSearch } from "@/lib/build-display-name";
import { batchHref } from "@/lib/review-context";
import { trpc } from "@/lib/trpc";

/** The fewest characters (spaces trimmed) that start a search. */
export const SEARCH_MIN_CHARS = 2;
/** The quiet after the last key before a search is asked. */
export const SEARCH_DEBOUNCE_MS = 150;
/** The rows shown per group. */
export const SEARCH_LIMIT = 8;
/**
 * How many of the newest batches are searched: the most one `builds.list`
 * page gives. `builds.list` has no text filter, so the Batches search box
 * filters what it loaded in the browser, and so does the palette.
 */
const BATCH_WINDOW = 100;
/**
 * How long the batch list stays fresh. It does not depend on what is typed,
 * so it is fetched once and filtered as the typing goes on; the app's
 * default (stale at once) would fetch it again at every pause.
 */
const BATCH_STALE_MS = 30_000;
/** The most `variations.list` takes in `search`; a longer text is cut to it. */
const TEST_SEARCH_MAX = 120;

/** A batch the search found. */
export interface BatchHit {
  id: string;
  projectId: string;
  name: string;
  branch: string | null;
  /** The steps in it that need review. */
  pending: number;
  href: string;
}

/** A test the search found. */
export interface TestHit {
  id: string;
  projectId: string;
  name: string;
  href: string;
}

/** One group's rows, or the fact that asking for them failed. */
export interface SearchGroup<T> {
  items: T[];
  error: boolean;
}

export interface PaletteSearch {
  batches: SearchGroup<BatchHit>;
  tests: SearchGroup<TestHit>;
  /**
   * An answer to what is typed is still to come: the typing has not settled,
   * or a group has not been answered or failed yet.
   */
  pending: boolean;
}

/** "‹name› · ‹branch› · ‹N› pending": a batch row (spec §5.2). */
export function batchRowLabel({ name, branch, pending }: BatchHit): string {
  return [name, branch, `${pending} pending`]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

/**
 * `value`, once it has stayed the same for the debounce. Starts empty, so
 * the first text is waited for too.
 */
function useSettled(value: string): string {
  const [settled, setSettled] = useState("");
  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, settled]);
  return settled;
}

/**
 * The palette's search over batches and tests for the current project (spec
 * §5.2). It asks nothing until 2 or more characters are typed and a project
 * exists, then once the typing has settled for 150 ms.
 *
 * - **Batches:** the project's newest batches whose name or branch contains
 *   the text (the Batches page's rule), 8 at most.
 * - **Tests:** `variations.list`'s `search`, 8 at most.
 * - **Stale answers:** a group shows the answer to the text that is settled
 *   now and to no other. Each text is its own react-query key, and nothing
 *   keeps an earlier answer on screen, so a slow answer to an earlier text,
 *   arriving late, is not shown for this one.
 * - **Errors:** a failed group is `error` with no rows; the other group is
 *   unaffected, and so is everything else in the palette. A failed batch
 *   list, once shown, is asked once more by the next search.
 */
export function usePaletteSearch(
  projectId: string | null,
  text: string,
): PaletteSearch {
  const query = text.trim();
  const settled = useSettled(query);
  const project =
    projectId !== null && query.length >= SEARCH_MIN_CHARS ? projectId : null;
  // Asked for what is typed now, once it has settled.
  const live = project !== null && settled === query;

  // The batch list is the same for any text: it is asked for as soon as a
  // search can start, not at each pause, and kept fresh for a while.
  const builds = trpc.builds.list.useQuery(
    { projectId: projectId ?? "", limit: BATCH_WINDOW },
    { enabled: project !== null, retry: false, staleTime: BATCH_STALE_MS },
  );
  const variations = trpc.variations.list.useQuery(
    {
      projectId: projectId ?? "",
      search: query.slice(0, TEST_SEARCH_MAX),
      limit: SEARCH_LIMIT,
    },
    { enabled: live, retry: false },
  );

  // The batch list's key never changes, so a failure would stay for the rest
  // of the session: nothing else asks again as the typing goes on. A failure
  // the user has been shown is asked about once more by the next search. Until
  // that answer is in, the old failure is not shown (it is not this search's).
  const batchesFailed = live && builds.isError && !builds.isFetching;
  const [seen, setSeen] = useState<{ failure: number; text: string } | null>(
    null,
  );
  const failure = builds.errorUpdateCount;
  const retryDue =
    batchesFailed && seen?.failure === failure && seen.text !== settled;
  const { refetch } = builds;
  useEffect(() => {
    if (!batchesFailed) return;
    if (retryDue) void refetch({ cancelRefetch: false });
    else if (seen?.failure !== failure) setSeen({ failure, text: settled });
  }, [batchesFailed, retryDue, seen, failure, settled, refetch]);
  const batchesAsking =
    live && builds.isError && (builds.isFetching || retryDue);

  const buildRows = builds.data?.items;
  const batchItems = useMemo((): BatchHit[] => {
    if (!live || project === null || !buildRows) return [];
    return buildRows
      .filter((b) => matchesBatchSearch(b, query))
      .slice(0, SEARCH_LIMIT)
      .map((b) => ({
        id: b.id,
        projectId: project,
        name: buildDisplayName(b),
        branch: b.branchName,
        pending: b.pendingCheckpoints,
        href: batchHref(project, b.id),
      }));
  }, [live, project, buildRows, query]);

  const variationRows = variations.data?.items;
  const testItems = useMemo((): TestHit[] => {
    if (!live || project === null || !variationRows) return [];
    return variationRows.map((v) => ({
      id: v.id,
      projectId: project,
      name: v.name,
      href: `/projects/${project}/variations/${v.id}`,
    }));
  }, [live, project, variationRows]);

  const batchError = live && builds.isError && !batchesAsking;
  const testError = live && variations.isError;
  return {
    batches: { items: batchError ? [] : batchItems, error: batchError },
    tests: { items: testError ? [] : testItems, error: testError },
    pending:
      project !== null &&
      (!live || builds.isPending || variations.isPending || batchesAsking),
  };
}
