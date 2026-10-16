"use client";

import Link from "next/link";
import { createContext, useContext, type ComponentProps } from "react";

import type { ViewerMode } from "./comparison-modes";

/**
 * R22: tells the viewer that a link inside it has started its navigation
 * (`useReviewLoop().linkNavigating`), so a mode change made before the route
 * commits re-targets that navigation instead of calling it off.
 */
type LinkNavigating = (
  href: string,
  inView?: (view: ViewerMode | null) => string,
) => void;

const ViewerLinkContext = createContext<LinkNavigating | null>(null);

/** The viewer's way to hear of its links' navigations (R22). */
export const ViewerLinkProvider = ViewerLinkContext.Provider;

type Props = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
  /**
   * The link's URL in another comparison mode, for a link to a step, so a
   * mode change on its way takes the link with it. Absent: a link out of
   * the viewer, the same in every mode.
   */
  inView?: (view: ViewerMode | null) => string;
};

/**
 * A `next/link` inside the diff viewer (R22). Once Next starts its
 * navigation (`onNavigate`: a plain click, not one for a new tab), the
 * viewer counts it as on its way, like a move of the review loop: a mode
 * change meanwhile (1–5, `d`, `o`, the radio group) re-targets it rather than
 * write the URL of the step on screen, which would make Next drop it. Outside
 * a viewer it is a plain link.
 */
export function ViewerLink({ href, inView, onNavigate, ...rest }: Props) {
  const navigating = useContext(ViewerLinkContext);
  return (
    <Link
      href={href}
      onNavigate={(e) => {
        // A caller's own onNavigate may call it off: then nothing is on its way.
        let cancelled = false;
        onNavigate?.({
          preventDefault: () => {
            cancelled = true;
            e.preventDefault();
          },
        });
        if (!cancelled) navigating?.(href, inView);
      }}
      {...rest}
    />
  );
}
