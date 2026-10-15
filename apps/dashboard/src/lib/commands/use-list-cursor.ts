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
 * - **Focus lost with an item** (the element focus was on has left the page
 *   and nothing else has focus) goes back to the cursor item, whether or not
 *   the cursor moved.
 * - **An emptied list** (rows giving way to a loading state) holds that
 *   record of where focus was for at most `KEEP_FOCUS_MS`: items that come
 *   back inside it get focus back, later ones (an event while the reviewer
 *   is elsewhere) never do. A key press or a pointer press in the meantime
 *   drops it at once.
 * - **Ids.** Only the ids in `items` are this list's: focus on an item of
 *   another list (one nested in this one) never moves its cursor.
 */

/**
 * How long an emptied list keeps the record of where focus was (Ruling R21):
 * enough for a filter change to reload, not for a later arrival to take focus.
 */
export const KEEP_FOCUS_MS = 2000;

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
  /** The list's items in walking order. The ids must be unique. */
  items: CursorItem[];
  /**
   * Where the cursor starts, without focus or scrolling. It is read when the
   * hook mounts (a later change is ignored), and it applies only if the first
   * non-empty `items` contain it: until then the cursor waits, and an id the
   * list never held is dropped (no cursor).
   */
  initialId?: string | null;
  /** The element that holds every item (`itemProps`'s elements). */
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
  // Set while the list is empty and holds a record of focus: the timer that
  // lets the record go (`KEEP_FOCUS_MS`).
  const emptiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    idsRef.current = ids;
  }, [ids]);

  /** Ends the wait of an emptied list, if there is one. */
  const stopWaiting = useCallback(() => {
    if (emptiedTimer.current === null) return;
    clearTimeout(emptiedTimer.current);
    emptiedTimer.current = null;
  }, []);

  /** An emptied list lets go of where focus was. */
  const forgetFocus = useCallback(() => {
    stopWaiting();
    focusedRef.current = null;
  }, [stopWaiting]);

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
      // An item of another list (nested in this one) is not this cursor's.
      if (id === null || !idsRef.current.includes(id)) return;
      if (id !== cursorRef.current) place(id, false);
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
    // The reviewer has moved on while the list was empty: where focus was is
    // no longer where they are.
    const onUserInput = () => {
      if (emptiedTimer.current !== null) forgetFocus();
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onUserInput, true);
    document.addEventListener("pointerdown", onUserInput, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onUserInput, true);
      document.removeEventListener("pointerdown", onUserInput, true);
    };
  }, [listRef, noteFocus, forgetFocus]);

  // Gone, the list waits for nothing.
  useLayoutEffect(() => stopWaiting, [stopWaiting]);

  // Keep the cursor's index; when its item is gone, move it to that index;
  // and give focus back to the cursor if it was lost with an item.
  useLayoutEffect(() => {
    if (ids.length === 0) {
      // Emptied (or not yet filled): the cursor waits for items, and a record
      // of focus is kept only for a short while, in case this is a reload.
      if (focusedRef.current !== null && emptiedTimer.current === null) {
        emptiedTimer.current = setTimeout(forgetFocus, KEEP_FOCUS_MS);
      }
      return;
    }
    stopWaiting();
    let id = cursorRef.current;
    if (id === null) return;
    const at = ids.indexOf(id);
    if (at >= 0) {
      indexRef.current = at;
    } else {
      const was = indexRef.current;
      if (was === null) {
        // An initialId the list doesn't hold.
        place(null, false);
        return;
      }
      id = ids[Math.min(was, ids.length - 1)] ?? null;
      if (id === null) return;
      place(id, false);
    }
    // Focus went with an item when the element it was on has left the page
    // and nothing else has it: it comes to the cursor item, which is the one
    // at that index when the cursor's own item was the one removed. Anywhere
    // else, it stays.
    const focused = focusedRef.current;
    const active = document.activeElement;
    if (
      focused !== null &&
      !focused.isConnected &&
      (active === null || active === document.body)
    ) {
      focusedRef.current = null;
      place(id, true);
    }
  }, [ids, cursorId, place, forgetFocus, stopWaiting]);

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
