/**
 * Shared checks for the ⌘K palette's tests (`cmdk.test.tsx`,
 * `cmdk-search.test.tsx`).
 */
import { screen } from "@testing-library/react";
import { expect } from "vitest";

/**
 * What a screen reader is told is chosen (R30): the search box (and the list)
 * name the one row that is chosen, by its id. cmdk keeps that name only when
 * its own select runs, so a row chosen any other way is chosen but not named.
 */
export function expectNamesChosenRow(palette: HTMLElement) {
  const chosen = palette.querySelectorAll(
    '[role="option"][aria-selected="true"]',
  );
  // One row is chosen, or none (no results); never more.
  expect(chosen.length).toBeLessThanOrEqual(1);
  const id = chosen[0]?.id ?? null;
  expect(
    screen.getByTestId("command-input").getAttribute("aria-activedescendant"),
  ).toBe(id);
  expect(
    palette
      .querySelector("[cmdk-list]")
      ?.getAttribute("aria-activedescendant") ?? null,
  ).toBe(id);
}
