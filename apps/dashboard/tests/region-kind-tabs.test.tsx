import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegionKindTabs } from "@/components/diff-viewer/RegionKindTabs";

afterEach(() => cleanup());

describe("RegionKindTabs", () => {
  it("renders five tabs in order", () => {
    render(<RegionKindTabs value="ignore" onChange={() => {}} />);
    const tabs = screen
      .getAllByRole("tab")
      .map((t) => t.textContent?.trim() ?? "");
    expect(
      tabs.slice(0, 5).map((s) => s.replace(/not yet enforced/i, "").trim()),
    ).toEqual(["Ignore", "Layout", "Floating", "Content", "A11y"]);
  });
  it("calls onChange with the clicked kind", () => {
    const onChange = vi.fn();
    render(<RegionKindTabs value="ignore" onChange={onChange} />);
    // Radix Tabs fires on mousedown — use fireEvent.mouseDown
    fireEvent.mouseDown(screen.getByRole("tab", { name: /layout/i }));
    expect(onChange).toHaveBeenCalledWith("layout");
  });
  it("4 non-enforced tabs show badge", () => {
    render(<RegionKindTabs value="ignore" onChange={() => {}} />);
    expect(screen.getAllByText(/not yet enforced/i).length).toBe(4);
  });
});
