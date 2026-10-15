"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ListCursor } from "@/lib/commands/use-list-cursor";

/**
 * The batch list's cursor, as its rows and step cards see it (spec §4.3,
 * §6). The list owns the cursor (`useListCursor`); a row or a card asks it
 * for its own item props (`useCursorItem`) and redraws only when its own
 * Tab stop changes, so a cursor move or a decision does not redraw the
 * cards beside it. A row also says what it holds (`useReportRow`), since its
 * run's steps and whether they are shown are its own.
 */

/** An item's props from the cursor (`ListCursor.itemProps`). */
export type CursorItemProps = ReturnType<ListCursor["itemProps"]>;

/** The cursor id of a run's result row: one per environment group (R22). */
export const runRowId = (runId: string, groupKey: string): string =>
  `run:${runId}:${groupKey}`;

/** The cursor id of a step card: checkpoint ids are unique on the page. */
export const stepItemId = (checkpointId: string): string =>
  `step:${checkpointId}`;

/**
 * The group key of a run's one row when it has no steps to group (none
 * loaded, or the facets leave none). A real group key always holds "|".
 */
export const NO_STEPS_GROUP = "none";

/** What one result row holds, as it says it. */
export interface RowReport {
  runId: string;
  /** Its place among its run's rows: capture order. */
  index: number;
  /** It has steps to show (its toggle does something). */
  expandable: boolean;
  /** Its steps are shown. */
  open: boolean;
  /** Its steps' checkpoint ids, in capture order. */
  stepIds: readonly string[];
  /** Shows or hides its steps, as its toggle does. Stable. */
  setOpen(open: boolean): void;
}

export interface BatchCursorChannel {
  /** The cursor's props for item `id`, as of the list's latest render. */
  itemProps(id: string): CursorItemProps;
  /** Calls `listener` after every render of the list. */
  subscribe(listener: () => void): () => void;
  /** A row says what it holds; null when it is gone. */
  reportRow(rowId: string, row: RowReport | null): void;
}

const BatchCursorContext = createContext<BatchCursorChannel | null>(null);

export const BatchCursorProvider = BatchCursorContext.Provider;

/**
 * The list's side: one stable channel for its rows and cards, carrying the
 * cursor's latest `itemProps` (set as the list renders, so the items it
 * renders read this render's), and telling the items it has rendered again.
 */
export function useBatchCursorChannel(
  itemProps: ListCursor["itemProps"],
  reportRow: BatchCursorChannel["reportRow"],
): BatchCursorChannel {
  const latest = useRef(itemProps);
  latest.current = itemProps;
  const report = useRef(reportRow);
  report.current = reportRow;
  const [{ channel, notify }] = useState(() => {
    const listeners = new Set<() => void>();
    return {
      channel: {
        itemProps: (id: string) => latest.current(id),
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        reportRow: (rowId: string, row: RowReport | null) =>
          report.current(rowId, row),
      } satisfies BatchCursorChannel,
      notify: () => {
        for (const listener of listeners) listener();
      },
    };
  });
  // After every render of the list: an item whose Tab stop changed (and only
  // such an item) redraws.
  useLayoutEffect(notify);
  return channel;
}

const NO_SUBSCRIPTION = () => () => undefined;

/**
 * Item `id`'s props from the batch list's cursor (spread on its element), or
 * null outside a batch list. The item redraws when its own Tab stop changes,
 * not when the cursor moves elsewhere.
 */
export function useCursorItem(id: string): CursorItemProps | null {
  const channel = useContext(BatchCursorContext);
  const tabIndex = useSyncExternalStore(
    channel?.subscribe ?? NO_SUBSCRIPTION,
    () => channel?.itemProps(id).tabIndex ?? null,
    () => channel?.itemProps(id).tabIndex ?? null,
  );
  if (channel === null || tabIndex === null) return null;
  return { ...channel.itemProps(id), tabIndex };
}

/**
 * Says what this row holds to the batch list, while it is mounted (outside a
 * batch list it does nothing). It says it again only when something in it
 * changes.
 */
export function useReportRow(rowId: string, row: RowReport): void {
  const channel = useContext(BatchCursorContext);
  const live = useRef(row);
  live.current = row;
  const said = JSON.stringify([
    row.runId,
    row.index,
    row.expandable,
    row.open,
    row.stepIds,
  ]);
  useLayoutEffect(() => {
    if (channel === null) return;
    channel.reportRow(rowId, live.current);
    return () => channel.reportRow(rowId, null);
  }, [channel, rowId, said]);
}
