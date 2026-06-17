import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getCheckpointGroupData = vi.fn();
const approveMutate = vi.fn();
const approveOnSuccess: { fn?: (res: unknown) => void } = {};
const invalidateGetById = vi.fn();
const invalidateListCheckpoints = vi.fn();
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

  it("confirm fires approveCheckpointGroup with {runId, checkpointId}, then invalidates + toasts + onResolved", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    const onResolved = vi.fn();
    render(
      <GroupApprovalCallout
        runId="run-1"
        checkpointId="c0"
        onResolved={onResolved}
      />,
    );
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
    expect(invalidateGetById).toHaveBeenCalledWith({ runId: "run-1" });
    expect(invalidateListCheckpoints).toHaveBeenCalledWith({ runId: "run-1" });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Approved 3 checkpoints across 2 runs",
    );
    expect(onResolved).toHaveBeenCalledTimes(1);
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
});
