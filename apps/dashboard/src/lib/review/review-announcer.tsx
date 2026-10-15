"use client";

import { useRef } from "react";
import { create } from "zustand";

/** How long an announcement stays in the region after the last one. */
const CLEAR_AFTER_MS = 7_000;

interface AnnouncerState {
  /** The last thing announced; empty again `CLEAR_AFTER_MS` after it. */
  text: string;
  /** Counts announcements, so the same words said twice are heard twice. */
  seq: number;
  announce(text: string): void;
}

/** The pending clear; one for the page, restarted by every announcement. */
let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The place the next announcement holds in the order things are said. Bumped
 * by every announcement and every reservation, so a reservation made before
 * one of those is out of date.
 */
let order = 0;

/**
 * What the review loop says to a screen reader when it moves the reviewer
 * somewhere they did not click (e.g. "Next test: Checkout · 4 left in batch").
 * A store, not component state: the loop that announces lives in a page that
 * the move itself replaces, and the words must outlive it.
 *
 * The text is emptied 7 s after the last announcement (the timer restarts on
 * each one): a cue left in the region would be read again to anyone browsing
 * the page, long after it stopped being true.
 */
export const useReviewAnnouncer = create<AnnouncerState>((set) => ({
  text: "",
  seq: 0,
  announce: (text) => {
    order += 1;
    set((s) => ({ text, seq: s.seq + 1 }));
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => set({ text: "" }), CLEAR_AFTER_MS);
  },
}));

/** Say `text` politely, from anywhere (no hook needed). */
export function announce(text: string): void {
  useReviewAnnouncer.getState().announce(text);
}

/**
 * Take a place in the order of announcements for words that are not ready yet
 * (a name still being fetched). The returned function says them only if
 * nothing was announced or reserved since: words that arrive after a later
 * move's cue would be a cue for a place the reviewer has already left. It
 * returns whether they were said.
 */
export function reserveAnnouncement(): (text: string) => boolean {
  order += 1;
  const mine = order;
  return (text) => {
    if (mine !== order) return false;
    announce(text);
    return true;
  };
}

/**
 * The one polite live region the loop speaks through. Mount it once, in a
 * layout that survives the loop's own navigation: a live region announces a
 * change inside a region that was already on the page, not one that appears
 * with its text. It is visually hidden; the move is visible in the page.
 *
 * The text sits in a keyed child, so an announcement is a new node each time
 * and the same words are announced again. A region that mounts starts empty,
 * whatever was said before it was there.
 */
export function ReviewAnnouncer() {
  const text = useReviewAnnouncer((s) => s.text);
  const seq = useReviewAnnouncer((s) => s.seq);
  const mountedAt = useRef(useReviewAnnouncer.getState().seq);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="review-announcer"
      className="sr-only"
    >
      <span key={seq}>{seq > mountedAt.current ? text : ""}</span>
    </div>
  );
}
