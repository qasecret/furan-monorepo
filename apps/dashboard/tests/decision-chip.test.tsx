import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DecisionChip } from "../src/components/diff-viewer/DecisionChip";
import type { CheckpointItem } from "../src/lib/review/optimistic";

type Decision = NonNullable<CheckpointItem["decision"]>;

const NOW = new Date("2026-10-10T12:00:00.000Z");

const decisionOf = (over: Partial<Decision> = {}): Decision => ({
  id: "decision-1",
  actionId: "action-1",
  kind: "approved",
  actor: { id: "user-1", name: "Grace" },
  at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
  source: "viewer",
  legacy: false,
  undo: { allowed: true },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DecisionChip", () => {
  it("names the decision, who made it and when", () => {
    const r = render(<DecisionChip decision={decisionOf()} onUndo={vi.fn()} />);
    const chip = r.getByTestId("decision-chip");
    expect(chip.textContent).toContain("Approved");
    expect(chip.textContent).toContain("Grace");
    expect(chip.textContent).toContain("5m ago");
  });

  it("puts the relative time in an element of its own, holding only that text", () => {
    // The e2e visual sweep masks an element by its exact text.
    const r = render(<DecisionChip decision={decisionOf()} onUndo={vi.fn()} />);
    const timed = r.getByText("5m ago");
    expect(timed.children).toHaveLength(0);
    expect(timed.textContent).toBe("5m ago");
  });

  it("reads 'Rejected' for a rejection", () => {
    const r = render(
      <DecisionChip
        decision={decisionOf({ kind: "rejected" })}
        onUndo={vi.fn()}
      />,
    );
    expect(r.getByTestId("decision-chip").textContent).toContain("Rejected");
  });

  it("leaves the name out when there is no actor", () => {
    const r = render(
      <DecisionChip decision={decisionOf({ actor: null })} onUndo={vi.fn()} />,
    );
    const text = r.getByTestId("decision-chip").textContent ?? "";
    expect(text).toContain("Approved");
    expect(text).toContain("5m ago");
    expect(text).not.toContain("Grace");
    // No dangling separators: one dot between the state and the time.
    expect(text.match(/·/g)).toHaveLength(1);
  });

  it("gives screen readers the state as text, not only a colour", () => {
    const r = render(<DecisionChip decision={decisionOf()} onUndo={vi.fn()} />);
    const label = r.getByText("Step decision:", { exact: false });
    expect(label.className).toContain("sr-only");
  });

  it("offers Undo when it is allowed and a handler is given", () => {
    const onUndo = vi.fn();
    const r = render(<DecisionChip decision={decisionOf()} onUndo={onUndo} />);
    const undo = r.getByTestId("decision-undo");
    expect(undo.getAttribute("aria-label")).toBe("Undo approval");
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("calls an undo of a rejection a rejection's", () => {
    const r = render(
      <DecisionChip
        decision={decisionOf({ kind: "rejected" })}
        onUndo={vi.fn()}
      />,
    );
    expect(r.getByTestId("decision-undo").getAttribute("aria-label")).toBe(
      "Undo rejection",
    );
  });

  it("offers no Undo without a handler, even when the server allows it", () => {
    const r = render(<DecisionChip decision={decisionOf()} />);
    expect(r.queryByTestId("decision-undo")).toBeNull();
  });

  it("disables Undo while busy", () => {
    const onUndo = vi.fn();
    const r = render(
      <DecisionChip decision={decisionOf()} onUndo={onUndo} busy />,
    );
    const undo = r.getByTestId("decision-undo") as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    fireEvent.click(undo);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("explains a refused undo in a tooltip, reachable by keyboard", async () => {
    vi.useRealTimers();
    const r = render(
      <DecisionChip
        decision={decisionOf({
          undo: { allowed: false, reason: "superseded_newer_capture" },
        })}
        onUndo={vi.fn()}
      />,
    );
    expect(r.queryByTestId("decision-undo")).toBeNull();
    const trigger = r.getByTestId("decision-chip").querySelector("[tabindex]");
    expect(trigger).not.toBeNull();
    await act(async () => {
      (trigger as HTMLElement).focus();
    });
    const tip = await r.findByTestId("decision-undo-reason");
    expect(tip.textContent).toBe(
      "Can't undo: a newer capture of this step exists",
    );
  });

  it("says who may undo it when the viewer is not the decider", async () => {
    vi.useRealTimers();
    const r = render(
      <DecisionChip
        decision={decisionOf({
          undo: { allowed: false, reason: "not_decider" },
        })}
      />,
    );
    await act(async () => {
      (
        r
          .getByTestId("decision-chip")
          .querySelector("[tabindex]") as HTMLElement
      ).focus();
    });
    expect((await r.findByTestId("decision-undo-reason")).textContent).toBe(
      "Can't undo: only the reviewer who decided or an admin can undo this",
    );
  });

  describe("a decision from before review history", () => {
    const legacy = (kind: "approved" | "rejected" = "approved") =>
      decisionOf({
        kind,
        legacy: true,
        actor: null,
        undo: { allowed: false, reason: "not_undoable_legacy" },
      });

    it("says so, with no reviewer or time", () => {
      const r = render(<DecisionChip decision={legacy()} onUndo={vi.fn()} />);
      const text = r.getByTestId("decision-chip").textContent ?? "";
      expect(text).toContain("Approved (before review history)");
      expect(text).not.toContain("ago");
      expect(text).not.toContain("·");
    });

    it("says it for a rejection too", () => {
      const r = render(<DecisionChip decision={legacy("rejected")} />);
      expect(r.getByTestId("decision-chip").textContent).toContain(
        "Rejected (before review history)",
      );
    });

    it("offers no Undo, and explains why through the same tooltip", async () => {
      vi.useRealTimers();
      const onUndo = vi.fn();
      const r = render(<DecisionChip decision={legacy()} onUndo={onUndo} />);
      expect(r.queryByTestId("decision-undo")).toBeNull();
      await act(async () => {
        (
          r
            .getByTestId("decision-chip")
            .querySelector("[tabindex]") as HTMLElement
        ).focus();
      });
      expect((await r.findByTestId("decision-undo-reason")).textContent).toBe(
        "Can't undo: decided before review history",
      );
      expect(onUndo).not.toHaveBeenCalled();
    });
  });
});
