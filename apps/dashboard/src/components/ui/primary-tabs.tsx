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
 * gets a soft zinc underline.
 *
 * Rendered as a row of Next.js `Link` elements so navigation stays fast
 * (no full-page reload on tab clicks). Disabled tabs render as inert spans
 * for tabs that point at routes not yet implemented (e.g. Variations
 * before its view ships).
 */
export function PrimaryTabs({ tabs }: { tabs: PrimaryTabDef[] }) {
  return (
    <nav
      className="flex gap-6 border-b border-zinc-200 bg-white px-6 dark:border-zinc-800 dark:bg-zinc-950"
      aria-label="Primary"
      data-testid="primary-tabs"
    >
      {tabs.map((tab) => {
        const baseClasses =
          "relative -mb-px inline-flex items-center gap-2 border-b-2 py-2.5 text-sm font-medium transition-all duration-150";
        const stateClasses = tab.isActive
          ? "border-brand text-zinc-900 dark:text-white"
          : tab.disabled
            ? "border-transparent text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
            : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-white";
        const inner = (
          <>
            <span>{tab.label}</span>
            {tab.badge ? (
              <span className="inline-flex h-4 items-center rounded-md border border-zinc-200 bg-zinc-100 px-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
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
