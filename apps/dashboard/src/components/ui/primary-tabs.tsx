import Link from "next/link";

import { cn } from "@/lib/cn";

export interface PrimaryTabDef {
  label: string;
  href: string;
  isActive: boolean;
  /** Optional small chip rendered after the label (e.g. "Beta", "Soon"). */
  badge?: string;
  /** Optional disabled state — renders dimmed and prevents navigation. */
  disabled?: boolean;
}

/**
 * Context-navigation tab strip rendered beneath the ContextualHeader.
 * Pure presentational: parent supplies the tab list with hrefs + `isActive`
 * derived from `usePathname`. Active tab gets a 2px brand underline; hover
 * gets a soft neutral underline.
 *
 * Rendered as a row of Next.js `Link` elements so navigation stays fast
 * (no full-page reload on tab clicks). Disabled tabs render as inert spans
 * for tabs that point at routes not yet implemented (e.g. Variations
 * before its view ships).
 */
export function PrimaryTabs({ tabs }: { tabs: PrimaryTabDef[] }) {
  return (
    <nav
      className="flex gap-6 border-b border-edge bg-raised px-6"
      aria-label="Primary"
      data-testid="primary-tabs"
    >
      {tabs.map((tab) => {
        const baseClasses =
          "relative -mb-px inline-flex items-center gap-2 border-b-2 py-2.5 text-sm font-medium transition-all duration-150";
        const stateClasses = tab.isActive
          ? "border-brand text-fg"
          : tab.disabled
            ? "border-transparent text-fg-muted/60 cursor-not-allowed"
            : "border-transparent text-fg-muted hover:border-edge-strong hover:text-fg";
        const inner = (
          <>
            <span>{tab.label}</span>
            {tab.badge ? (
              <span className="inline-flex h-4 items-center rounded-md border border-edge bg-muted px-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                {tab.badge}
              </span>
            ) : null}
          </>
        );
        if (tab.disabled) {
          return (
            <span
              key={tab.href || tab.label}
              className={cn(baseClasses, stateClasses)}
              aria-disabled
              data-testid={`primary-tab-${slug(tab.label)}`}
            >
              {inner}
            </span>
          );
        }
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.isActive ? "page" : undefined}
            className={cn(baseClasses, stateClasses)}
            data-testid={`primary-tab-${slug(tab.label)}`}
          >
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "-");
}
