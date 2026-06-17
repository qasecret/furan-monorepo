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

afterEach(cleanup);

function Harness(props: Partial<GroupApprovalCalloutViewProps>) {
  const [action, setAction] = useState<"accept" | "reject" | null>(null);
  return (
    <GroupApprovalCalloutView
      checkpointCount={2}
      runCount={2}
      capped={false}
      runs={RUNS}
      isPending={false}
      action={action}
      onAccept={() => setAction("accept")}
      onReject={() => setAction("reject")}
      onOpenChange={(o) => {
        if (!o) setAction(null);
      }}
      onConfirm={() => undefined}
      {...props}
    />
  );
}

describe("GroupApprovalCalloutView", () => {
  it("renders nothing when checkpointCount is 0", () => {
    const { container } = render(<Harness checkpointCount={0} runs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the chip copy + both action buttons", () => {
    render(<Harness />);
    expect(screen.getByTestId("group-approval-callout").textContent).toContain(
      "2 other checkpoints",
    );
    expect(screen.getByTestId("group-approval-accept-all")).toBeTruthy();
    expect(screen.getByTestId("group-approval-reject-all")).toBeTruthy();
  });

  it("shows a + suffix when capped", () => {
    render(<Harness capped={true} />);
    expect(screen.getByTestId("group-approval-callout").textContent).toContain(
      "2+ other checkpoints",
    );
  });

  it("Accept all opens the accept dialog listing other runs; confirm fires onConfirm", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    const dialog = screen.getByTestId("group-approval-dialog");
    expect(dialog.textContent).toContain("approved");
    expect(screen.getByTestId("group-approval-run-list").textContent).toContain(
      "HomePage",
    );
    expect(screen.getByTestId("group-approval-confirm").textContent).toContain(
      "Accept all",
    );
    fireEvent.click(screen.getByTestId("group-approval-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Reject all opens a reject dialog whose copy says runs will be failed", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("group-approval-reject-all"));
    const dialog = screen.getByTestId("group-approval-dialog");
    expect(dialog.textContent).toContain("failed");
    expect(screen.getByTestId("group-approval-confirm").textContent).toContain(
      "Reject all",
    );
    fireEvent.click(screen.getByTestId("group-approval-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables confirm while pending", () => {
    render(<Harness action="accept" isPending={true} />);
    expect(
      (screen.getByTestId("group-approval-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("labels the run list 'Other affected runs (M)'", () => {
    render(<Harness action="accept" />);
    expect(screen.getByTestId("group-approval-dialog").textContent).toContain(
      "Other affected runs (2)",
    );
  });

  it("Cancel closes the dialog", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    expect(screen.getByTestId("group-approval-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("group-approval-cancel"));
    expect(screen.queryByTestId("group-approval-dialog")).toBeNull();
  });

  it("reject confirm shows 'Rejecting…' and is disabled while pending", () => {
    render(<Harness action="reject" isPending={true} />);
    const confirm = screen.getByTestId(
      "group-approval-confirm",
    ) as HTMLButtonElement;
    expect(confirm.textContent).toContain("Rejecting…");
    expect(confirm.disabled).toBe(true);
  });
});
