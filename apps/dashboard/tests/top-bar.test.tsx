/**
 * TopBar smoke test — clicking the search button must open the cmdk
 * palette via the shared zustand store. Without this gate, the topbar
 * could ship as inert UI that looks right but does nothing.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TopBar } from "../src/app/(protected)/_components/top-bar";
import { usePaletteStore } from "../src/components/cmdk/use-command-palette";

beforeEach(() => {
  usePaletteStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
  usePaletteStore.setState({ open: false });
});

describe("TopBar", () => {
  test("clicking the search button opens the cmdk palette", () => {
    render(<TopBar />);
    expect(usePaletteStore.getState().open).toBe(false);

    fireEvent.click(screen.getByTestId("top-bar-search"));
    expect(usePaletteStore.getState().open).toBe(true);
  });

  test("notification bell is disabled stub", () => {
    render(<TopBar />);
    const bell = screen.getByTestId("top-bar-bell") as HTMLButtonElement;
    expect(bell.disabled).toBe(true);
    expect(bell.getAttribute("aria-disabled")).toBe("true");
  });
});
