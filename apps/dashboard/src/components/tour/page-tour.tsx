"use client";

import { useMemo } from "react";

import { useTourSteps, type TourStep } from "./tour-context";

interface Props {
  pageId: string;
  steps: TourStep[];
}

/**
 * Tiny client island that lets server-rendered pages register their
 * tour steps without becoming clients themselves. Renders nothing —
 * the actual overlay is mounted once in the root `Providers`.
 *
 * The `steps` prop is memoized via JSON identity so a parent that
 * inlines the array each render does not retrigger the start. Pages
 * with truly dynamic steps should compose them outside JSX once and
 * pass the stable reference in.
 */
export function PageTour({ pageId, steps }: Props) {
  const memoized = useMemo(() => steps, [steps]);
  useTourSteps(pageId, memoized);
  return null;
}
