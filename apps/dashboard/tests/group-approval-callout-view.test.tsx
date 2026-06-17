import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GroupApprovalCalloutView,
  type GroupApprovalCalloutViewProps,
} from "../src/components/diff-viewer/GroupApprovalCalloutView";

const RUNS = [
  { id: "r1", testName: "HomePage" },
  { id: "r2", testName: "SearchResults" },
];

// open/onOpenChange are controlled props; wrap so the chip button can open the dialog.
function Harness(props: Partial<GroupApprovalCalloutViewProps>) {
  const [open, setOpen] = useState(false);
  return (
    <GroupApprovalCalloutView
      checkpointCount={2}
      runCount={2}
      capped={false}
      runs={RUNS}
      isPending={false}
      open={open}
      onOpenChange={setOpen}
      onAcceptAll={() => undefined}
      {...props}
    />
  );
}

describe("GroupApprovalCalloutView", () => {
  afterEach(() => cleanup());

  it("renders nothing when checkpointCount is 0", () => {
    const { container } = render(<Harness checkpointCount={0} runs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the callout copy with counts", () => {
    render(<Harness />);
    const callout = screen.getByTestId("group-approval-callout");
    expect(callout.textContent).toContain("2 other checkpoints");
    expect(callout.textContent).toContain("2 runs");
  });

  it("shows a + suffix when capped", () => {
    render(<Harness capped={true} />);
    expect(screen.getByTestId("group-approval-callout").textContent).toContain(
      "2+ other checkpoints",
    );
  });

  it("opens a dialog listing affected runs; confirm calls onAcceptAll", () => {
    const onAcceptAll = vi.fn();
    render(<Harness onAcceptAll={onAcceptAll} />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    const list = screen.getByTestId("group-approval-run-list");
    expect(list.textContent).toContain("HomePage");
    expect(list.textContent).toContain("SearchResults");
    fireEvent.click(screen.getByTestId("group-approval-confirm"));
    expect(onAcceptAll).toHaveBeenCalledTimes(1);
  });

  it("disables confirm while pending", () => {
    render(<Harness isPending={true} />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    expect(
      (screen.getByTestId("group-approval-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("Cancel closes the dialog", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    expect(screen.getByTestId("group-approval-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("group-approval-cancel"));
    expect(screen.queryByTestId("group-approval-dialog")).toBeNull();
  });

  it("dialog description shows the capped suffix", () => {
    render(<Harness capped={true} />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    expect(screen.getByTestId("group-approval-dialog").textContent).toContain(
      "2+ other unresolved checkpoints",
    );
  });
});
