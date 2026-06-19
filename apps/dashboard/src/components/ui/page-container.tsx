import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

const MAXW = {
  "3xl": "max-w-3xl",
  "5xl": "max-w-5xl",
  "7xl": "max-w-7xl",
} as const;

interface Props {
  children: ReactNode;
  /** Bounded height, full width, NO scroll/pad — the page's own panels scroll. */
  fullBleed?: boolean;
  /** Centered width (ignored when fullBleed). Default "7xl". */
  maxWidth?: keyof typeof MAXW;
  /** Extra classes on the centered inner (or the bleed root). */
  className?: string;
}

/**
 * The single slot every protected page renders into. AppShell's <main> is now a
 * bounded, clipping flex container (flex min-h-0 flex-1 flex-col overflow-hidden);
 * PageContainer is its flex child, so `flex-1 min-h-0` hands it that bounded height.
 *
 * - centered (default): THIS div is the page's scroll region; the inner div
 *   reproduces the old `mx-auto max-w-7xl px-6 py-6` look.
 * - fullBleed: a bare bounded flex column — the page's own overflow-y-auto panels
 *   scroll because their ancestor finally has a real bounded height.
 */
export function PageContainer({
  children,
  fullBleed = false,
  maxWidth = "7xl",
  className,
}: Props) {
  if (fullBleed) {
    return (
      <div
        data-testid="page-bleed"
        className={cn("flex min-h-0 flex-1 flex-col", className)}
      >
        {children}
      </div>
    );
  }
  return (
    <div data-testid="page-scroll" className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto px-6 py-6", MAXW[maxWidth], className)}>
        {children}
      </div>
    </div>
  );
}
