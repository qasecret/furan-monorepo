import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The review hook is mocked: its own suite covers what a group decision does
// (the call, the Undo toast, the refresh). The container's job is to ask the
// reviewer, make the right call and stay open until it ends.
const { reviewSpies, inFlight } = vi.hoisted(() => {
  const inFlight = new Set<string>();
  return {
    inFlight,
    reviewSpies: {
      decide: vi.fn(),
      undo: vi.fn(),
      approveBuild: vi.fn(),
      decideGroup: vi.fn(),
      isInFlight: (id: string) => inFlight.has(id),
    },
  };
});
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => reviewSpies,
}));

const getCheckpointGroupData = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    runs: {
      getCheckpointGroup: {
        useQuery: (_input: unknown, _opts: unknown) => ({
          data: getCheckpointGroupData(),
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));

import { GroupApprovalCallout } from "../src/components/diff-viewer/GroupApprovalCallout";

beforeEach(() => {
  inFlight.clear();
  reviewSpies.decideGroup.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  getCheckpointGroupData.mockReturnValue(undefined);
});

const GROUP = {
  checkpoints: [
    {
      id: "c1",
      runId: "r1",
      testName: "HomePage",
      name: "hero",
      viewport: "1280x720",
    },
    {
      id: "c2",
      runId: "r2",
      testName: "SearchResults",
      name: "list",
      viewport: "1280x720",
    },
  ],
  checkpointCount: 2,
  runCount: 2,
  capped: false,
};

const confirmButton = () =>
  screen.getByTestId("group-approval-confirm") as HTMLButtonElement;

describe("GroupApprovalCallout (container)", () => {
  it("renders nothing when there is no checkpointId", () => {
    getCheckpointGroupData.mockReturnValue(undefined);
    const { container } = render(<GroupApprovalCallout runId="run-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the group is empty", () => {
    getCheckpointGroupData.mockReturnValue({
      checkpoints: [],
      checkpointCount: 0,
      runCount: 0,
      capped: false,
    });
    const { container } = render(
      <GroupApprovalCallout runId="run-1" checkpointId="c0" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("asks first: nothing is decided until the reviewer confirms", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    expect(screen.getByTestId("group-approval-dialog")).toBeTruthy();
    expect(reviewSpies.decideGroup).not.toHaveBeenCalled();
  });

  /** The one `decideGroup` call, and the toast text it words from a result. */
  const decideGroupCall = () => {
    expect(reviewSpies.decideGroup).toHaveBeenCalledOnce();
    const args = reviewSpies.decideGroup.mock.calls[0]![0] as {
      label: (result: unknown) => string;
    } & Record<string, unknown>;
    expect(typeof args.label).toBe("function");
    const { label, ...rest } = args;
    const toast = (decided: number) =>
      label({
        actionId: "a1",
        decided: Array.from({ length: decided }, (_, i) => ({
          checkpointId: `c${i}`,
          runId: "r1",
          state: "approved",
        })),
        runs: [{ runId: "r1", status: "passed" }],
        replayed: false,
        capped: false,
        cap: 200,
      });
    return { args: rest, toast };
  };

  it("Accept all confirm approves the group through the review hook", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    fireEvent.click(confirmButton());
    const { args, toast } = decideGroupCall();
    expect(args).toEqual({
      runId: "run-1",
      checkpointId: "c0",
      kind: "approved",
    });
    expect(toast(3)).toBe("Approved 3 steps");
  });

  it("Reject all confirm rejects the group through the review hook", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-reject-all"));
    fireEvent.click(confirmButton());
    const { args, toast } = decideGroupCall();
    expect(args).toEqual({
      runId: "run-1",
      checkpointId: "c0",
      kind: "rejected",
    });
    expect(toast(2)).toBe("Rejected 2 steps");
  });

  it("words the toast from what the server decided, the seed step included", () => {
    // The callout counts 2 other steps in the group; the server decided those
    // and the step in view too, and the toast says 3.
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    fireEvent.click(confirmButton());
    expect(decideGroupCall().toast(3)).toBe("Approved 3 steps");
  });

  it("words one step in the singular", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-reject-all"));
    fireEvent.click(confirmButton());
    expect(decideGroupCall().toast(1)).toBe("Rejected 1 step");
  });

  it("stays open, busy, until the call ends, then closes", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    // The hook holds the seed step while the call is out.
    reviewSpies.decideGroup.mockImplementation(() => inFlight.add("c0"));
    const { rerender } = render(
      <GroupApprovalCallout runId="run-1" checkpointId="c0" />,
    );
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    fireEvent.click(confirmButton());

    expect(screen.getByTestId("group-approval-dialog")).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().textContent).toContain("Approving…");

    inFlight.delete("c0");
    rerender(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    expect(screen.queryByTestId("group-approval-dialog")).toBeNull();
    expect(reviewSpies.decideGroup).toHaveBeenCalledOnce();
  });

  it("cannot be confirmed while the step it is built around has a decision on its way", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    inFlight.add("c0");
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(reviewSpies.decideGroup).not.toHaveBeenCalled();
  });

  it("Cancel decides nothing", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-reject-all"));
    fireEvent.click(screen.getByTestId("group-approval-cancel"));
    expect(screen.queryByTestId("group-approval-dialog")).toBeNull();
    expect(reviewSpies.decideGroup).not.toHaveBeenCalled();
  });

  it("reject dialog counts the seed's own run (runCount + 1) when it isn't among the others", () => {
    // GROUP.runCount = 2 (runs r1, r2); the viewed run "run-1" is not among them,
    // so a reject touches 3 runs — the dialog must say 3, not the seed-excluded 2.
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-reject-all"));
    const dialog = screen.getByTestId("group-approval-dialog");
    expect(dialog.textContent).toContain("3 runs");
    expect(dialog.textContent).toContain("including the one you're viewing");
    // The "Other affected runs" list still shows the 2 other runs.
    expect(dialog.textContent).toContain("Other affected runs (2)");
  });
});
