"use client";

import { HelpCircle } from "lucide-react";

import { useTourOptional } from "./tour-context";

/**
 * Top-bar button that re-launches the current page's tour. Hidden
 * entirely when the page has no registered tour — keeps the bar
 * uncluttered on pages without an onboarding flow (login, account
 * settings, etc.).
 *
 * The visibility logic reads `state.pageId` not `state.active`: the
 * button SHOULD show on a page where the user previously dismissed
 * the tour, since the whole purpose is to recover from a dismissal.
 *
 * Mirrors the styling of the disabled Bell next to it so it looks
 * native to the top bar.
 */
export function HelpButton() {
  // Tolerant of a missing provider so existing TopBar-in-isolation
  // tests don't have to know about the tour wiring. Returns null in
  // that case — production always has the provider mounted in app
  // root `Providers`.
  const tour = useTourOptional();
  if (!tour || !tour.state.pageId || tour.state.steps.length === 0) return null;
  const { relaunch } = tour;
  return (
    <button
      type="button"
      onClick={relaunch}
      aria-label="Replay tour for this page"
      title="Replay tour"
      data-testid="top-bar-help"
      className="p-2 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-900/50 transition-colors"
    >
      <HelpCircle className="w-5 h-5" />
    </button>
  );
}
