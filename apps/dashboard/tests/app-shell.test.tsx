import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

// The shell's own part is the order of what it holds and the skip link: the
// sidebar and the top bar are stood in for by one focusable control each, so
// "first" means before everything the shell contains.
vi.mock("@/app/(protected)/_components/sidebar", () => ({
  Sidebar: () => (
    <nav aria-label="Primary">
      <a href="/inbox">Batches</a>
    </nav>
  ),
}));
vi.mock("@/app/(protected)/_components/top-bar", () => ({
  TopBar: () => (
    <header>
      <button type="button">Top bar control</button>
    </header>
  ),
}));

import { AppShell } from "@/app/(protected)/_components/app-shell";

afterEach(cleanup);

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

function mount() {
  return render(
    <AppShell userRole="editor" userEmail="me@x.io" userInitial="M">
      <button type="button">Page control</button>
    </AppShell>,
  );
}

describe("AppShell skip link", () => {
  test("skip link is first and focuses main", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    const skip = screen.getByRole("link", { name: "Skip to main content" });

    // First in the tab order: nothing focusable comes before it.
    expect(container.querySelector(FOCUSABLE)).toBe(skip);
    await user.tab();
    expect(document.activeElement).toBe(skip);

    // Activated, it moves focus to the main region (which takes focus by
    // script only, not in the tab order).
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(skip.getAttribute("href")).toBe("#main");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(main);

    // The next Tab goes into the page, past the sidebar and the top bar.
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Page control" }),
    );
  });

  test("the skip link is hidden until it is focused", () => {
    mount();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip.classList.contains("sr-only")).toBe(true);
    expect(skip.classList.contains("focus:not-sr-only")).toBe(true);
  });

  test("a click works too, and leaves the address alone", async () => {
    const user = userEvent.setup();
    mount();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    const before = window.location.href;
    await user.click(skip);
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(window.location.href).toBe(before);
    // The browser's own jump to `#main` is called off (`fireEvent` is false
    // for a click whose default was prevented).
    expect(fireEvent.click(skip)).toBe(false);
  });
});
