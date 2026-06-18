import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getCheckpointGroupData = vi.fn();
const approveMutate = vi.fn();
const rejectMutate = vi.fn();
const approveOnSuccess: { fn?: (res: unknown) => void } = {};
const rejectOnSuccess: { fn?: (res: unknown) => void } = {};
const invalidateGetById = vi.fn();
const invalidateListCheckpoints = vi.fn();
const invalidateGetCheckpointGroup = vi.fn();
const toastSuccess = vi.fn();

vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: vi.fn() },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      runs: {
        getById: { invalidate: (i: unknown) => invalidateGetById(i) },
        listCheckpoints: {
          invalidate: (i: unknown) => invalidateListCheckpoints(i),
        },
        getCheckpointGroup: {
          invalidate: (i: unknown) => invalidateGetCheckpointGroup(i),
        },
      },
    }),
    runs: {
      getCheckpointGroup: {
        useQuery: (_input: unknown, _opts: unknown) => ({
          data: getCheckpointGroupData(),
          isLoading: false,
          error: null,
        }),
      },
      approveCheckpointGroup: {
        useMutation: (opts?: { onSuccess?: (res: unknown) => void }) => {
          approveOnSuccess.fn = opts?.onSuccess;
          return {
            mutate: (input: unknown) => approveMutate(input),
            isPending: false,
          };
        },
      },
      rejectCheckpointGroup: {
        useMutation: (opts?: { onSuccess?: (res: unknown) => void }) => {
          rejectOnSuccess.fn = opts?.onSuccess;
          return {
            mutate: (input: unknown) => rejectMutate(input),
            isPending: false,
          };
        },
      },
    },
  },
}));

import { GroupApprovalCallout } from "../src/components/diff-viewer/GroupApprovalCallout";

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

  it("Accept all confirm fires approveCheckpointGroup, invalidates broadly + toasts", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    fireEvent.click(screen.getByTestId("group-approval-confirm"));
    expect(approveMutate).toHaveBeenCalledWith({
      runId: "run-1",
      checkpointId: "c0",
    });
    approveOnSuccess.fn?.({
      approved: 3,
      runCount: 2,
      capped: false,
      cap: 200,
    });
    expect(invalidateGetById).toHaveBeenCalled();
    expect(invalidateListCheckpoints).toHaveBeenCalled();
    expect(invalidateGetCheckpointGroup).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(
      "Approved 3 checkpoints across 2 runs",
    );
  });

  it("Reject all confirm fires rejectCheckpointGroup, invalidates broadly + toasts", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-reject-all"));
    fireEvent.click(screen.getByTestId("group-approval-confirm"));
    expect(rejectMutate).toHaveBeenCalledWith({
      runId: "run-1",
      checkpointId: "c0",
    });
    rejectOnSuccess.fn?.({ rejected: 2, runCount: 2, capped: false, cap: 200 });
    expect(invalidateGetById).toHaveBeenCalled();
    expect(invalidateListCheckpoints).toHaveBeenCalled();
    expect(invalidateGetCheckpointGroup).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Rejected 2 runs");
  });

  it("appends a capped suffix to the toast", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-accept-all"));
    fireEvent.click(screen.getByTestId("group-approval-confirm"));
    approveOnSuccess.fn?.({
      approved: 200,
      runCount: 12,
      capped: true,
      cap: 200,
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Approved 200 checkpoints across 12 runs (capped at 200 — run again for more)",
    );
  });

  it("appends a capped suffix to the reject toast", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<GroupApprovalCallout runId="run-1" checkpointId="c0" />);
    fireEvent.click(screen.getByTestId("group-approval-reject-all"));
    fireEvent.click(screen.getByTestId("group-approval-confirm"));
    rejectOnSuccess.fn?.({
      rejected: 200,
      runCount: 200,
      capped: true,
      cap: 200,
    });
    // Reject is non-progressive when capped (re-running re-fails the same runs),
    // so the suffix must NOT say "run again for more" (unlike the accept toast).
    expect(toastSuccess).toHaveBeenCalledWith(
      "Rejected 200 runs (capped at 200 runs)",
    );
  });

  it("reject dialog counts the seed's own run (runCount + 1) when it isn't among the others", () => {
    // GROUP.runCount = 2 (runs r1, r2); the viewed run "run-1" is not among them,
    // so a reject fails 3 runs — the dialog must say 3, not the seed-excluded 2.
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
