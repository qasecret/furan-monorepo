import { cleanup, render, screen } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import { afterEach, describe, expect, test } from "vitest";

import { ThemeToggle } from "@/components/ui/theme-toggle";

// next-themes calls window.matchMedia internally; jsdom doesn't implement it.
// Both the modern addEventListener/removeEventListener and the legacy
// addListener/removeListener forms are required.
class MockMatchMedia {
  constructor(private query: string) {
    void this.query; // suppress TS "unused" warning
  }
  matches = false;
  addEventListener() {}
  removeEventListener() {}
  addListener() {}
  removeListener() {}
  dispatchEvent() {
    return false;
  }
}
// @ts-expect-error -- jsdom doesn't have matchMedia
global.matchMedia = (q: string) => new MockMatchMedia(q);

afterEach(cleanup);

describe("ThemeToggle", () => {
  test("renders the toggle button after mount", async () => {
    render(
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
        <ThemeToggle />
      </ThemeProvider>,
    );
    // The button uses data-testid so the test isn't coupled to the glyph.
    // useEffect runs after the initial render, so we wait briefly.
    await new Promise((r) => setTimeout(r, 10));
    const btn = screen.queryByTestId("theme-toggle");
    expect(btn).not.toBeNull();
  });
});
