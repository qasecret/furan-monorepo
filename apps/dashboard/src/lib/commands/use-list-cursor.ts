"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { LIST_ITEM } from "./guard";

/**
 * A roving list cursor (spec §6). One item of a list is the cursor: it is
 * the list's one Tab stop (`tabIndex` 0, every other item -1), and focus is
 * how it shows. The hook moves the cursor and focus; it binds no keys. The
 * page's commands (`list.next` and the rest) call `next`, `prev`, `first`
 * and `last`.
 *
 * - **Focus sets it.** Focus landing anywhere in an item (the item itself or
 *   a control inside it, by a click, Tab, or a handoff such as "Back to
 *   batch" or a step card moving focus to its Undo) makes that item the
 *   cursor; with items inside items, the innermost.
 * - **Keyed by id.** It survives refetches and reorders. When its item
 *   disappears, it moves to the item now at the index its item last had, or
 *   to the last item. It takes focus with it only when focus went with the
 *   item; focus elsewhere on the page is never moved.
 */

/** An entry of the list, in the order the cursor walks it. */
export interface CursorItem {
  id: string;
}

/** The attribute `itemProps` marks an item with: the guard's `LIST_ITEM`. */
const ATTR = "data-cursor-id";

export interface ListCursor {
  /** The cursor item's id, or null before there is one. */
  cursorId: string | null;
  /**
   * Puts the cursor on `id`, and with `focus` moves focus (and the view) to
   * it. An id the list doesn't hold is ignored.
   */
  setCursor(id: string, focus?: boolean): void;
  /** The next item, focused. With no cursor yet, the first. */
  next(): void;
  /** The previous item, focused. With no cursor yet, the first. */
  prev(): void;
  first(): void;
  last(): void;
  /** Spread on each item's element. */
  itemProps(id: string): {
    tabIndex: 0 | -1;
    "data-cursor-id": string;
    onFocus: () => void;
  };
}

/** The rendered element of item `id` in `list`. */
function findItem(list: HTMLElement | null, id: string): HTMLElement | null {
  if (list === null) return null;
  for (const el of list.querySelectorAll<HTMLElement>(LIST_ITEM)) {
    if (el.getAttribute(ATTR) === id) return el;
  }
  return null;
}

/** The id of the innermost item of `list` that `target` is in. */
function itemIdOf(
  list: HTMLElement | null,
  target: EventTarget | null,
): string | null {
  if (list === null || !(target instanceof Element)) return null;
  if (!list.contains(target)) return null;
  const el = target.closest(LIST_ITEM);
  if (el === null || !list.contains(el)) return null;
  return el.getAttribute(ATTR);
}

export function useListCursor({
  items,
  initialId = null,
  listRef,
}: {
  items: CursorItem[];
  initialId?: string | null;
  listRef: RefObject<HTMLElement | null>;
}): ListCursor {
  const [cursorId, setCursorId] = useState<string | null>(initialId);
  // The ids, kept the same array while they don't change (callers build
  // `items` afresh on every render).
  const idsKey = JSON.stringify(items.map((i) => i.id));
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);

  // For the callbacks, which run between renders: the committed ids and the
  // cursor as last set.
  const idsRef = useRef(ids);
  const cursorRef = useRef(cursorId);
  // The index the cursor's item last had: where the cursor goes if it goes.
  const indexRef = useRef<number | null>(null);
  // The element in the list focus last landed on, until focus goes
  // somewhere else. If the list then loses it, focus went with the item.
  const focusedRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    idsRef.current = ids;
  }, [ids]);

  /** Moves the cursor to `id`; with `focus`, focus and the view follow. */
  const place = useCallback(
    (id: string | null, focus: boolean) => {
      cursorRef.current = id;
      if (id !== null) {
        const at = idsRef.current.indexOf(id);
        if (at >= 0) indexRef.current = at;
      }
      setCursorId(id);
      if (!focus || id === null) return;
      const el = findItem(listRef.current, id);
      if (el === null) return;
      // Scrolled by `scrollIntoView` alone: the least it takes ("nearest",
      // where focus's own scroll may centre), and never smooth.
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    },
    [listRef],
  );

  /** Focus landed on `target`: the item it is in becomes the cursor. */
  const noteFocus = useCallback(
    (target: EventTarget | null) => {
      const list = listRef.current;
      if (list === null || !(target instanceof Element)) return;
      if (!list.contains(target)) return;
      focusedRef.current = target;
      const id = itemIdOf(list, target);
      if (id !== null && id !== cursorRef.current) place(id, false);
    },
    [listRef, place],
  );

  // An item's own onFocus. React's focus events bubble, so this also runs
  // for focus on a control inside the item; the item is read from what has
  // focus, so with items inside items the innermost one wins.
  const onItemFocus = useCallback(
    () => noteFocus(document.activeElement),
    [noteFocus],
  );

  // Focus within the list, seen by the document as well: it still sets the
  // cursor when a consumer's own onFocus replaces the item's, and it tells
  // focus in the list from focus elsewhere.
  useLayoutEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const list = listRef.current;
      if (
        list !== null &&
        e.target instanceof Node &&
        list.contains(e.target)
      ) {
        noteFocus(e.target);
      } else {
        focusedRef.current = null;
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      const from = e.target;
      if (e.relatedTarget !== null || from !== focusedRef.current) return;
      if (!(from instanceof Element)) return;
      // Focus went to nothing. A click on the page's background lets it go;
      // an item removed from under it (which some browsers report as a blur,
      // in the middle of the re-render) does not. Judged in a microtask, so
      // after that re-render and its layout effects; a window losing focus
      // keeps `activeElement`, so it doesn't count.
      queueMicrotask(() => {
        if (
          focusedRef.current === from &&
          from.isConnected &&
          document.activeElement !== from
        ) {
          focusedRef.current = null;
        }
      });
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [listRef, noteFocus]);

  // Keep the cursor's index; when its item is gone, move it to that index.
  useLayoutEffect(() => {
    const id = cursorRef.current;
    if (id === null) return;
    const at = ids.indexOf(id);
    if (at >= 0) {
      indexRef.current = at;
      return;
    }
    // Nothing to move to yet: an initialId, or the cursor, waits for items.
    if (ids.length === 0) return;
    const was = indexRef.current;
    if (was === null) {
      // An initialId the list doesn't hold.
      place(null, false);
      return;
    }
    // Focus went with the item when the element it was on has left the
    // page and nothing else has it. Anywhere else, it stays.
    const focused = focusedRef.current;
    const active = document.activeElement;
    const focusWentWithIt =
      focused !== null &&
      !focused.isConnected &&
      (active === null || active === document.body);
    const to = ids[Math.min(was, ids.length - 1)];
    if (to !== undefined) place(to, focusWentWithIt);
  }, [ids, cursorId, place]);

  const setCursor = useCallback(
    (id: string, focus = false) => {
      if (idsRef.current.includes(id)) place(id, focus);
    },
    [place],
  );

  /** Focuses the item `to` picks from the cursor's index (-1: none). */
  const move = useCallback(
    (to: (at: number, lastIndex: number) => number) => {
      const list = idsRef.current;
      if (list.length === 0) return;
      const cur = cursorRef.current;
      const at = cur === null ? -1 : list.indexOf(cur);
      const id = list[to(at, list.length - 1)];
      if (id !== undefined) place(id, true);
    },
    [place],
  );
  const next = useCallback(
    () => move((at, end) => (at < 0 ? 0 : Math.min(at + 1, end))),
    [move],
  );
  const prev = useCallback(
    () => move((at) => (at < 0 ? 0 : Math.max(at - 1, 0))),
    [move],
  );
  const first = useCallback(() => move(() => 0), [move]);
  const last = useCallback(() => move((_at, end) => end), [move]);

  // The Tab stop: the cursor, or the first item while there is none.
  const tabStop =
    cursorId !== null && ids.includes(cursorId) ? cursorId : (ids[0] ?? null);
  const itemProps = (id: string) => ({
    tabIndex: id === tabStop ? (0 as const) : (-1 as const),
    [ATTR]: id,
    onFocus: onItemFocus,
  });

  return { cursorId, setCursor, next, prev, first, last, itemProps };
}
