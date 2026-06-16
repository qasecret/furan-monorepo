"use client";

import { useEffect, useState } from "react";

/**
 * Returns `true` when the user's OS/browser has
 * `prefers-reduced-motion: reduce` set.
 *
 * - SSR/jsdom safe: returns `false` when `window` or `window.matchMedia` is
 *   unavailable.
 * - Subscribes to runtime changes (user toggles the OS setting while the page
 *   is open) via the MediaQueryList `change` event.
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => {
      setReducedMotion(e.matches);
    };
    mql.addEventListener("change", handler);
    return () => {
      mql.removeEventListener("change", handler);
    };
  }, []);

  return reducedMotion;
}
