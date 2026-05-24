"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Step in a page's guided tour. `target` is a CSS selector resolved at
 * render time via `document.querySelector` — we anchor the popover to
 * the element's `getBoundingClientRect()`.
 *
 * `placement` is a hint, not a constraint. The overlay uses the hint
 * unless the popover would clip the viewport, in which case it flips to
 * the opposite side. Most page steps want `bottom`.
 */
export interface TourStep {
  target: string;
  title?: string;
  content: string;
  placement?: "top" | "bottom" | "left" | "right";
}

interface TourState {
  /** Page identifier — used as the localStorage key for dismiss-once. */
  pageId: string | null;
  steps: TourStep[];
  index: number;
  /** `true` only when a tour is mid-flight; false once dismissed/finished. */
  active: boolean;
}

interface TourApi {
  state: TourState;
  /** Register the steps for the current page; auto-starts unless dismissed. */
  startIfNew: (pageId: string, steps: TourStep[]) => void;
  next: () => void;
  prev: () => void;
  /** Skip = dismiss for this page + remember the choice across reloads. */
  dismiss: () => void;
}

const TourContext = createContext<TourApi | null>(null);

const DISMISS_PREFIX = "furan:tour:dismissed:";

function isDismissed(pageId: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(DISMISS_PREFIX + pageId) === "1";
  } catch {
    // localStorage can throw under privacy modes — treat that as
    // "already dismissed" so users in those modes do not get a tour
    // they cannot dismiss persistently.
    return true;
  }
}

function setDismissed(pageId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_PREFIX + pageId, "1");
  } catch {
    // ignored — same rationale as isDismissed
  }
}

/**
 * App-root provider. Each page calls `useTourSteps(pageId, steps)` to
 * register its own steps; the provider owns the active-step state and
 * the dismissal flag, the overlay component reads from this context.
 *
 * Spec: legacy `frontend/src/contexts/help.context.tsx` + `constants/help.ts`
 * (v1.0 audit gap — last item). Furan's port keeps the same behavior
 * (per-page step list, dismiss-once persistence) but drops the legacy
 * `react-joyride` dep in favor of a shadcn-styled inline overlay.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TourState>({
    pageId: null,
    steps: [],
    index: 0,
    active: false,
  });

  const startIfNew = useCallback((pageId: string, steps: TourStep[]) => {
    if (steps.length === 0 || isDismissed(pageId)) return;
    setState({ pageId, steps, index: 0, active: true });
  }, []);

  const next = useCallback(() => {
    setState((s) => {
      if (!s.active) return s;
      if (s.index >= s.steps.length - 1) {
        // Finishing the tour counts as a dismissal so it does not
        // re-appear on the next visit.
        if (s.pageId) setDismissed(s.pageId);
        return { ...s, active: false };
      }
      return { ...s, index: s.index + 1 };
    });
  }, []);

  const prev = useCallback(() => {
    setState((s) =>
      s.active && s.index > 0 ? { ...s, index: s.index - 1 } : s,
    );
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => {
      if (s.pageId) setDismissed(s.pageId);
      return { ...s, active: false };
    });
  }, []);

  const api: TourApi = useMemo(
    () => ({ state, startIfNew, next, prev, dismiss }),
    [state, startIfNew, next, prev, dismiss],
  );

  return <TourContext.Provider value={api}>{children}</TourContext.Provider>;
}

export function useTour(): TourApi {
  const ctx = useContext(TourContext);
  if (!ctx) {
    throw new Error("useTour must be used within a TourProvider");
  }
  return ctx;
}

/**
 * Page-level hook: registers tour steps on mount, no-op on unmount.
 * Pages call this once at the top of their main client component
 * (typically the page-level client island that already mounts other
 * hooks like `useProjectEvents`).
 *
 * `steps` is captured by reference; pass a stable array (module-level
 * const) so changes do not retrigger the start.
 */
export function useTourSteps(pageId: string, steps: TourStep[]): void {
  const { startIfNew } = useTour();
  // Capture the start call in a ref so we are not bound by exhaustive-
  // deps to re-run on every render. Mount-only side effect.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startIfNew(pageId, steps);
  }, [pageId, steps, startIfNew]);
}

/** Test-only seam: clears dismissal flags so tests can re-trigger tours. */
export function __resetTourDismissalsForTests(): void {
  if (typeof window === "undefined") return;
  try {
    const keys = Object.keys(window.localStorage).filter((k) =>
      k.startsWith(DISMISS_PREFIX),
    );
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    // ignored
  }
}
