import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/cn";

export interface BreadcrumbCrumb {
  label: string;
  href?: string;
}

/**
 * Breadcrumb trail. Pure presentation — the caller composes the crumbs
 * (parents own routing knowledge). The last crumb renders as the current
 * page (non-link, `aria-current="page"`); earlier crumbs with an `href`
 * render as links.
 *
 * Lifted out of the diff viewer's `ContextualHeader` so the global TopBar
 * trail and the viewer share one implementation.
 */
export function Breadcrumbs({
  items,
  className,
}: {
  items: BreadcrumbCrumb[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400",
        className,
      )}
      data-testid="breadcrumbs"
    >
      {items.map((crumb, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span
            key={`${crumb.label}-${idx}`}
            className="flex min-w-0 items-center gap-1.5"
          >
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                className="truncate transition-colors hover:text-zinc-900 dark:hover:text-white"
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={
                  isLast
                    ? "truncate font-medium text-zinc-700 dark:text-zinc-200"
                    : "truncate"
                }
                aria-current={isLast ? "page" : undefined}
              >
                {crumb.label}
              </span>
            )}
            {!isLast ? (
              <ChevronRight
                className="h-3 w-3 shrink-0 text-zinc-400 dark:text-zinc-600"
                aria-hidden
              />
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
