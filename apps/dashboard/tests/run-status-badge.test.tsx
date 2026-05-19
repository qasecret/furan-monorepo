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

  it("applies distinct colour classes for unresolved (amber) vs aborted (yellow)", () => {
    const { rerender } = render(<RunStatusBadge status="unresolved" />);
    const unresolvedEl = screen.getByTestId("run-status-badge-unresolved");
    expect(unresolvedEl.className).toContain("amber");
    expect(unresolvedEl.className).not.toContain("yellow");

    rerender(<RunStatusBadge status="aborted" />);
    const abortedEl = screen.getByTestId("run-status-badge-aborted");
    expect(abortedEl.className).toContain("yellow");
    expect(abortedEl.className).not.toContain("amber");
  });
});
