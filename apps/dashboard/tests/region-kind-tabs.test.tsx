import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegionKindTabs } from "@/components/diff-viewer/RegionKindTabs";
import type { RegionKindTab } from "@/components/diff-viewer/useViewerStore";

afterEach(() => cleanup());

describe("RegionKindTabs", () => {
  it("renders exactly three visible tabs: ignore, layout, content", () => {
    render(<RegionKindTabs value="ignore" onChange={() => {}} />);
    const tabs = screen
      .getAllByRole("tab")
      .map((t) => t.textContent?.trim() ?? "");
    const normalized = tabs.map((s) => s.replace(/preview/i, "").trim());
    expect(normalized).toEqual(["Ignore", "Layout", "Content"]);
  });

  it("does NOT render floating or a11y/accessibility tabs", () => {
    render(<RegionKindTabs value="ignore" onChange={() => {}} />);
    expect(screen.queryByRole("tab", { name: /floating/i })).toBeNull();
    expect(
      screen.queryByRole("tab", { name: /a11y|accessibility/i }),
    ).toBeNull();
  });

  it("calls onChange with the clicked kind", () => {
    const onChange = vi.fn();
    render(<RegionKindTabs value="ignore" onChange={onChange} />);
    // Radix Tabs fires on mousedown — use fireEvent.mouseDown
    fireEvent.mouseDown(screen.getByRole("tab", { name: /layout/i }));
    expect(onChange).toHaveBeenCalledWith("layout");
  });

  it("2 non-enforced visible tabs (layout, content) show preview badge", () => {
    render(<RegionKindTabs value="ignore" onChange={() => {}} />);
    // "ignore" is enforced (no badge), "layout" and "content" are not.
    expect(screen.getAllByText(/preview/i).length).toBe(2);
  });

  it("falls back to ignore when value is a hidden kind (floating)", () => {
    render(
      <RegionKindTabs
        value={"floating" as RegionKindTab}
        onChange={() => {}}
      />,
    );
    // The ignore tab should be shown as active; floating tab must not exist.
    const ignoreTab = screen.getByRole("tab", { name: /^ignore$/i });
    expect(ignoreTab.getAttribute("data-state")).toBe("active");
    expect(screen.queryByRole("tab", { name: /floating/i })).toBeNull();
  });

  it("falls back to ignore when value is a hidden kind (accessibility)", () => {
    render(
      <RegionKindTabs
        value={"accessibility" as RegionKindTab}
        onChange={() => {}}
      />,
    );
    const ignoreTab = screen.getByRole("tab", { name: /^ignore$/i });
    expect(ignoreTab.getAttribute("data-state")).toBe("active");
    expect(
      screen.queryByRole("tab", { name: /a11y|accessibility/i }),
    ).toBeNull();
  });
});
