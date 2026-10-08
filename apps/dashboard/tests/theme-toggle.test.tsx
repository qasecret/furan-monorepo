import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ThemeProvider } from "@/components/ui/theme-provider";
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

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "";
});

// Radix DropdownMenu opens on pointerdown (primary button), not click. userEvent
// dispatches the full pointer-event sequence (pointerdown -> mousedown ->
// pointerup -> click) that jsdom needs; a bare fireEvent.click would not open it.
async function renderToggle() {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  // useEffect flips the mount guard after the first render.
  return screen.findByTestId("theme-toggle");
}

describe("ThemeToggle", () => {
  const user = userEvent.setup();

  test("renders the toggle button after mount", async () => {
    const btn = await renderToggle();
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Theme");
  });

  test("opens a menu with Light, Dark and System", async () => {
    await user.click(await renderToggle());
    expect(
      await screen.findByRole("menuitemradio", { name: "Light" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "System" })).toBeTruthy();
  });

  test("marks System as the current choice when nothing is stored", async () => {
    await user.click(await renderToggle());
    const system = await screen.findByRole("menuitemradio", { name: "System" });
    expect(system.getAttribute("aria-checked")).toBe("true");
  });

  test("choosing Light sets light", async () => {
    // Start from a stored dark choice so the class removal is caused by the click.
    localStorage.setItem("furan-theme", "dark");
    await user.click(await renderToggle());
    const light = await screen.findByRole("menuitemradio", { name: "Light" });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await user.click(light);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(false),
    );
    expect(localStorage.getItem("furan-theme")).toBe("light");
  });

  test("choosing Dark sets dark", async () => {
    await user.click(await renderToggle());
    const dark = await screen.findByRole("menuitemradio", { name: "Dark" });
    await user.click(dark);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
    expect(localStorage.getItem("furan-theme")).toBe("dark");
  });
});
