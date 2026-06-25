"use client";

import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Fade-and-rise-in wrapper for landing sections.
 *
 * Reveals on mount with an optional stagger `delay`, so it can never get stuck
 * hidden — there's no viewport/observer dependency to misfire. The hidden start
 * state is scoped to `.reveal-on` (a class the root layout sets before first
 * paint only when JS is present), so without JS the content renders fully
 * visible instead of blank — see globals.css `.reveal`. Reduced-motion users
 * skip the transition entirely (also handled in globals.css).
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  /** Stagger, in ms, applied as transition-delay. */
  delay?: number;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Flip to visible after mount. React runs effects after the browser has
    // painted the hidden start state, so the transition still animates — and
    // unlike requestAnimationFrame this can't be throttled in a backgrounded
    // / non-visible tab, which would otherwise leave content stuck hidden.
    setVisible(true);
  }, []);

  return (
    <div
      className={cn("reveal", visible && "is-visible", className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
