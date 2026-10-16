"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/**
 * The keys that move cmdk's choice (it has no PageUp or PageDown of its own,
 * but a reader who presses one has reached for the list). A reader who has
 * pressed one has made the choice theirs (R29).
 */
const MOVE_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);

/**
 * The events the palette sends cmdk itself. They stay inside the palette:
 * the page's key listeners must not see a key nobody pressed. They are
 * stopped where the palette's React handlers run, which is below `document`
 * and `window`; a capture-phase listener (the list cursor's, on `document`)
 * runs first and still sees them.
 */
const OWN_EVENTS = new WeakSet<Event>();

interface Choice {
  /** The row chosen with an empty search, and again when it is cleared. */
  startsOn: string;
  /** The text typed. */
  search: string;
  /** Batches and tests are still being searched for (or the typing hasn't settled). */
  pending: boolean;
  /** How many batch and test rows are shown. */
  rowCount: number;
}

/**
 * Which row of the palette is chosen: where it starts, where it goes back to
 * when the search is cleared, and the R29 rule for when the search answers.
 *
 * R29: once the search of batches and tests has answered for the text, the
 * first row as it is shown is the choice, unless the reader has moved it
 * since the text last changed. cmdk chooses a row when the text changes,
 * among the commands and pages that match then; the rows that arrive later
 * may be shown above it, and cmdk leaves its choice where it was.
 *
 * The palette chooses the first row the way cmdk does for the Home key, by a
 * keydown on its root: cmdk takes the first selectable row of its sorted list
 * (a failed search's row is disabled, so never chosen), and it also updates
 * `aria-activedescendant`, which a value set from outside does not. It is
 * sent in a timeout, so that cmdk has put the new rows in its list first. The
 * choice is made once for a text: Home locks it, as the reader's own keys
 * (arrows, Home, End, PageUp, PageDown, unless an IME is composing) and a
 * pointer moved over a row cmdk can choose do, until the text changes.
 *
 * The effect depends on `pending` and `rowCount` only. A change of the text
 * that leaves both as they were (a space typed after the answer) needs no
 * choice of its own: cmdk chooses its first row when the text changes, which
 * is this one ("a space typed after the answer chooses the first row again").
 */
export function usePaletteChoice({
  startsOn,
  search,
  pending,
  rowCount,
}: Choice) {
  const rootRef = useRef<HTMLDivElement>(null);
  const locked = useRef(false);

  // The chosen row is held here, not by cmdk, so that clearing the search can
  // put it back: cmdk chooses its first row whenever the search changes.
  const [chosen, setChosen] = useState(startsOn);
  useEffect(() => {
    // Runs after cmdk's own choice for this search (a layout effect), so the
    // starting row wins.
    if (search === "") setChosen(startsOn);
  }, [search, startsOn]);

  useEffect(() => {
    if (pending || rowCount === 0) return;
    const timer = setTimeout(() => {
      if (locked.current) return;
      // The Home key locks the choice too (see `onKeyDown`).
      const home = new KeyboardEvent("keydown", {
        key: "Home",
        bubbles: true,
        cancelable: true,
      });
      OWN_EVENTS.add(home);
      rootRef.current?.dispatchEvent(home);
    }, 0);
    return () => clearTimeout(timer);
  }, [pending, rowCount]);

  return {
    rootRef,
    /** Call when the typed text changes: the choice is the first row's again. */
    textChanged: () => {
      locked.current = false;
    },
    /** Props for cmdk's `Command`. */
    commandProps: {
      value: chosen,
      onValueChange: setChosen,
      onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
        // The palette's own keys go no further than the palette. cmdk still
        // handles them: it only asks whether the event was prevented.
        if (OWN_EVENTS.has(e.nativeEvent)) e.stopPropagation();
        // As cmdk itself: a key pressed to compose text is not a move.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (MOVE_KEYS.has(e.key)) locked.current = true;
      },
      onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
        // cmdk chooses the row under the pointer; that is the reader's
        // choice. A disabled row, or no row at all, is not chosen.
        if (
          e.target instanceof Element &&
          e.target.closest('[cmdk-item]:not([aria-disabled="true"])')
        ) {
          locked.current = true;
        }
      },
    },
  };
}
