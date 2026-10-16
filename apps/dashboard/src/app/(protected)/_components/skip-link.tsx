"use client";

/**
 * "Skip to main content": the first focusable element of the shell, there for
 * keyboard and screen-reader users to get past the sidebar and the top bar.
 * Hidden (`sr-only`) until it has focus, then a small button at the top left.
 *
 * Activated, it focuses the target itself instead of navigating to `#main`:
 * that leaves the address alone and does not depend on the browser moving
 * focus for a fragment. The target needs `tabIndex={-1}` to take focus.
 */
export function SkipLink({ targetId }: { targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      onClick={(e) => {
        const target = document.getElementById(targetId);
        if (!target) return;
        e.preventDefault();
        target.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-overlay focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-fg focus:shadow-overlay focus-ring"
    >
      Skip to main content
    </a>
  );
}
