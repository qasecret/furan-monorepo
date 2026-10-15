"use client";

import { create } from "zustand";

interface AnnouncerState {
  /** The last thing announced. */
  text: string;
  /** Counts announcements, so the same words said twice are heard twice. */
  seq: number;
  announce(text: string): void;
}

/**
 * What the review loop says to a screen reader when it moves the reviewer
 * somewhere they did not click (e.g. "Next test: Checkout · 4 left in batch").
 * A store, not component state: the loop that announces lives in a page that
 * the move itself replaces, and the words must outlive it.
 */
export const useReviewAnnouncer = create<AnnouncerState>((set) => ({
  text: "",
  seq: 0,
  announce: (text) => set((s) => ({ text, seq: s.seq + 1 })),
}));

/** Say `text` politely, from anywhere (no hook needed). */
export function announce(text: string): void {
  useReviewAnnouncer.getState().announce(text);
}

/**
 * The one polite live region the loop speaks through. Mount it once, in a
 * layout that survives the loop's own navigation: a live region announces a
 * change inside a region that was already on the page, not one that appears
 * with its text. It is visually hidden; the move is visible in the page.
 *
 * The text sits in a keyed child, so an announcement is a new node each time
 * and the same words are announced again.
 */
export function ReviewAnnouncer() {
  const text = useReviewAnnouncer((s) => s.text);
  const seq = useReviewAnnouncer((s) => s.seq);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="review-announcer"
      className="sr-only"
    >
      <span key={seq}>{text}</span>
    </div>
  );
}
