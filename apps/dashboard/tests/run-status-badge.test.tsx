/**
 * Spec §3.5 coverage: one assertion per `RunStatus` value confirming the
 * label renders, plus the load-bearing amber-vs-yellow distinction between
 * `unresolved` (needs reviewer) and `aborted` (infra issue).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RunStatusBadge } from "../src/components/run-status-badge";

const ALL_STATUSES = [
  "new",
  "running",
  "passed",
  "unresolved",
  "failed",
  "aborted",
  "empty",
] as const;

const LABELS: Record<(typeof ALL_STATUSES)[number], string> = {
  new: "New",
  running: "Running",
  passed: "Passed",
  unresolved: "Unresolved",
  failed: "Failed",
  aborted: "Aborted",
  empty: "Empty",
};

describe("RunStatusBadge", () => {
  afterEach(() => cleanup());

  for (const status of ALL_STATUSES) {
    it(`renders the ${status} pill with the right label`, () => {
      render(<RunStatusBadge status={status} />);
      expect(screen.getByText(LABELS[status])).toBeDefined();
      expect(screen.getByTestId(`run-status-badge-${status}`)).toBeDefined();
    });
  }

  it("applies distinct token classes for unresolved vs aborted", () => {
    const { rerender } = render(<RunStatusBadge status="unresolved" />);
    const unresolvedEl = screen.getByTestId("run-status-badge-unresolved");
    expect(unresolvedEl.className).toContain("status-unresolved");
    expect(unresolvedEl.className).not.toContain("status-aborted");

    rerender(<RunStatusBadge status="aborted" />);
    const abortedEl = screen.getByTestId("run-status-badge-aborted");
    expect(abortedEl.className).toContain("status-aborted");
    expect(abortedEl.className).not.toContain("status-unresolved");
  });

  it("renders a decorative status icon before the label", () => {
    render(<RunStatusBadge status="passed" />);
    const el = screen.getByTestId("run-status-badge-passed");
    const svg = el.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(el.firstElementChild).toBe(svg);
  });

  it("spins only the running icon, and only when motion is allowed", () => {
    const { rerender } = render(<RunStatusBadge status="running" />);
    const running = screen
      .getByTestId("run-status-badge-running")
      .querySelector("svg")!;
    expect(running.getAttribute("class")).toContain("motion-safe:animate-spin");

    rerender(<RunStatusBadge status="passed" />);
    const passed = screen
      .getByTestId("run-status-badge-passed")
      .querySelector("svg")!;
    expect(passed.getAttribute("class")).not.toContain("animate-spin");
  });
});
