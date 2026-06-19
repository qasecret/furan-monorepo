import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CollapsibleSection } from "@/components/ui/collapsible-section";

afterEach(cleanup);

describe("CollapsibleSection", () => {
  test("renders the title and, when open, the children", () => {
    render(
      <CollapsibleSection title="Basics" open onOpenChange={vi.fn()}>
        <p>body content</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText("Basics")).toBeDefined();
    expect(screen.getByText("body content")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: /Basics/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("hides children when closed and reports toggles", () => {
    const onOpenChange = vi.fn();
    render(
      <CollapsibleSection
        title="Limits"
        open={false}
        onOpenChange={onOpenChange}
      >
        <p>hidden body</p>
      </CollapsibleSection>,
    );
    expect(screen.queryByText("hidden body")).toBeNull();
    const header = screen.getByRole("button", { name: /Limits/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
