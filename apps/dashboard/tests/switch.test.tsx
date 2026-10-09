import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Switch } from "@/components/ui/switch";

afterEach(cleanup);

/**
 * The Switch must read as a control in both themes (design-foundation spec §4):
 * the unchecked track is `fg-muted` (>= 3:1 against every surface), the thumb
 * is white on it, and the checked state is a lime track with a `brand-fg`
 * thumb. tests/tokens-contrast.test.ts pins those pairs' contrast.
 */
function renderSwitch(checked: boolean) {
  render(
    <Switch aria-label="toggle" checked={checked} onCheckedChange={() => {}} />,
  );
  const track = screen.getByRole("switch", { name: "toggle" });
  const thumb = track.querySelector("span");
  expect(thumb).not.toBeNull();
  return { track, thumb: thumb! };
}

function classes(el: Element): string[] {
  return el.className.split(/\s+/);
}

describe("Switch", () => {
  test("unchecked track is fg-muted; checked track is brand", () => {
    const { track } = renderSwitch(false);
    expect(classes(track)).toContain("bg-fg-muted");
    expect(classes(track)).toContain("data-[state=checked]:bg-brand");
    expect(classes(track)).not.toContain("bg-edge-strong");
  });

  test("thumb is white, brand-fg when checked", () => {
    const { thumb } = renderSwitch(false);
    expect(classes(thumb)).toContain("bg-white");
    expect(classes(thumb)).toContain("data-[state=checked]:bg-brand-fg");
    expect(classes(thumb)).not.toContain("bg-canvas");
  });

  test("Radix puts data-state on the thumb, so its checked variant applies", () => {
    expect(renderSwitch(false).thumb.getAttribute("data-state")).toBe(
      "unchecked",
    );
    cleanup();
    expect(renderSwitch(true).thumb.getAttribute("data-state")).toBe("checked");
  });
});
