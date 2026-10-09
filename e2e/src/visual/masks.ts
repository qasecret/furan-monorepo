import type { Locator, Page } from "@playwright/test";

/**
 * Locators for text that changes between a `before` and an `after` run on the
 * same data: the outputs of the dashboard's `formatRelativeTime` ("just now",
 * "5m ago", "3h ago", "2d ago") and `formatBatchDateTime`
 * ("8 Oct 2026 at 9:41 PM"), both in `apps/dashboard/src/lib/format.ts`.
 * Screenshots paint these boxes over, so a clock tick never reads as a diff.
 */
export function timeMasks(page: Page): Locator[] {
  return [
    page.getByText(/^(just now|\d+[mhd] ago)$/),
    page.getByText(/^\d{1,2} [A-Z][a-z]{2} \d{4} at \d{1,2}:\d{2} [AP]M$/),
  ];
}
