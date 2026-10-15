import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ContextualHeader } from "@/components/diff-viewer/ContextualHeader";

type Loop = NonNullable<ComponentProps<typeof ContextualHeader>["loop"]>;

function renderHeader(loop?: Loop, backHref?: string) {
  return render(
    <ContextualHeader
      title="Checkout"
      status="unresolved"
      branch="main"
      {...(backHref ? { backHref } : {})}
      {...(loop ? { loop } : {})}
    />,
  );
}

const loop = (over: Partial<Loop> = {}): Loop => ({
  remaining: "5 left in batch",
  onNextPending: vi.fn(),
  nextLabel: "Next pending",
  ...over,
});

afterEach(() => cleanup());

describe("ContextualHeader: the review loop", () => {
  test("shows how many are left and a Next pending button that moves", () => {
    const l = loop();
    renderHeader(l);
    expect(screen.getByTestId("header-loop-remaining").textContent).toBe(
      "5 left in batch",
    );
    const next = screen.getByTestId("header-next-pending");
    expect(next.getAttribute("aria-label")).toBe("Next pending step");
    expect(next.textContent).toContain("Next pending");
    fireEvent.click(next);
    expect(l.onNextPending).toHaveBeenCalledOnce();
  });

  test("without a loop there is no pill and no Next pending", () => {
    renderHeader();
    expect(screen.queryByTestId("header-loop-remaining")).toBeNull();
    expect(screen.queryByTestId("header-next-pending")).toBeNull();
  });

  test("Next pending is busy while a decision waits for the next step, and still pressable", () => {
    const l = loop({ pending: true });
    const { rerender } = renderHeader(l);
    const next = screen.getByTestId("header-next-pending") as HTMLButtonElement;
    expect(next.getAttribute("aria-busy")).toBe("true");
    expect(next.disabled).toBe(false);
    expect(next.textContent).toBe("Next pending");
    // The spinner turns only when motion is allowed.
    const spinner = screen.getByTestId("header-next-pending-busy");
    expect(spinner.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(spinner.getAttribute("class")).not.toMatch(/(^|\s)animate-spin/);
    fireEvent.click(next);
    expect(l.onNextPending).toHaveBeenCalledOnce();

    rerender(
      <ContextualHeader
        title="Checkout"
        status="unresolved"
        loop={loop({ pending: false })}
      />,
    );
    expect(next.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByTestId("header-next-pending-busy")).toBeNull();
  });

  test("no pill until the count is known; Next pending is there already", () => {
    renderHeader(loop({ remaining: "" }));
    expect(screen.queryByTestId("header-loop-remaining")).toBeNull();
    expect(screen.getByTestId("header-next-pending")).toBeDefined();
  });

  test("the cue chip sits by the pill, hidden from screen readers, and fades in only when motion is allowed", () => {
    renderHeader(loop({ cue: "Next test: Checkout · 4 left in batch" }));
    const chip = screen.getByTestId("header-loop-cue");
    expect(chip.textContent).toBe("Next test: Checkout · 4 left in batch");
    // The live region already says it.
    expect(chip.getAttribute("aria-hidden")).toBe("true");
    // Every animation class is behind motion-safe: none under reduced motion.
    const classes = chip.className.split(/\s+/);
    expect(classes.some((c) => c.startsWith("motion-safe:"))).toBe(true);
    expect(
      classes.filter((c) => /animat/.test(c) && !c.startsWith("motion-safe:")),
    ).toEqual([]);
  });

  test("no cue, no chip", () => {
    renderHeader(loop());
    expect(screen.queryByTestId("header-loop-cue")).toBeNull();
  });

  test("a failed lookup is said beside the pill, with Retry, in a status region that is always mounted", () => {
    const onRetry = vi.fn();
    const { rerender } = renderHeader(loop({ onRetry }));
    const region = screen.getByTestId("header-loop-error");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");
    expect(region.className).toContain("sr-only");
    expect(screen.queryByTestId("header-loop-retry")).toBeNull();

    rerender(
      <ContextualHeader
        title="Checkout"
        status="unresolved"
        loop={loop({ onRetry, error: "Couldn't load the next step." })}
      />,
    );
    // The same region, now with its text, and visible.
    expect(screen.getByTestId("header-loop-error")).toBe(region);
    expect(region.textContent).toBe("Couldn't load the next step.");
    expect(region.className).not.toContain("sr-only");
    const retry = screen.getByTestId("header-loop-retry");
    expect(retry.getAttribute("aria-label")).toBe(
      "Retry loading the next step",
    );
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("no Retry button when there is nothing to retry with", () => {
    renderHeader(loop({ error: "Couldn't load the next step." }));
    expect(screen.getByTestId("header-loop-error").textContent).toBe(
      "Couldn't load the next step.",
    );
    expect(screen.queryByTestId("header-loop-retry")).toBeNull();
  });

  test("the back link goes where it is told", () => {
    renderHeader(undefined, "/projects/p1/builds/b1?status=failed#run-r1");
    expect(
      screen.getByTestId("contextual-header-back").getAttribute("href"),
    ).toBe("/projects/p1/builds/b1?status=failed#run-r1");
  });
});
