import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the tRPC client. We stub the mutation hooks directly rather than
// running a real httpBatchLink through a fake fetch — this keeps the test
// asserting *our* component behavior (which mutation is called with which
// input) instead of tRPC's wire format.
const approveMutate = vi.fn();
const rejectMutate = vi.fn();
const overrideMutate = vi.fn();
const bulkApproveMutate = vi.fn();
const invalidate = vi.fn();

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let approveState = { isPending: false };
let rejectState = { isPending: false };
let overrideState = { isPending: false };
let approveOnError: ((e: { message: string }) => void) | undefined;

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      runs: { getById: { invalidate } },
    }),
    runs: {
      approve: {
        useMutation: (opts?: {
          onMutate?: () => void;
          onSuccess?: () => void;
          onError?: (e: { message: string }) => void;
        }) => {
          approveOnError = opts?.onError;
          return {
            mutate: (input: { runId: string }) => {
              opts?.onMutate?.();
              approveMutate(input);
              opts?.onSuccess?.();
            },
            isPending: approveState.isPending,
          };
        },
      },
      reject: {
        useMutation: (opts?: {
          onMutate?: () => void;
          onSuccess?: () => void;
          onError?: (e: { message: string }) => void;
        }) => ({
          mutate: (input: { runId: string }) => {
            opts?.onMutate?.();
            rejectMutate(input);
            opts?.onSuccess?.();
          },
          isPending: rejectState.isPending,
        }),
      },
      overrideStatus: {
        useMutation: (opts?: {
          onMutate?: () => void;
          onSuccess?: () => void;
          onError?: (e: { message: string }) => void;
        }) => ({
          mutate: (input: { runId: string; status: string }) => {
            opts?.onMutate?.();
            overrideMutate(input);
            opts?.onSuccess?.();
          },
          isPending: overrideState.isPending,
        }),
      },
      // Bulk-approve-by-variation mock — minimal shape so the existing
      // approval-bar tests keep passing. Dedicated assertions for the
      // dropdown live in tests further down (see "bulk approve" block).
      bulkApproveByVariation: {
        useMutation: (opts?: {
          onMutate?: () => void;
          onSuccess?: (res: {
            approved: number;
            runIds: string[];
            capped: boolean;
            cap: number;
          }) => void;
          onError?: (e: { message: string }) => void;
        }) => ({
          mutate: (input: { runId: string }) => {
            opts?.onMutate?.();
            bulkApproveMutate(input);
            opts?.onSuccess?.({
              approved: 3,
              runIds: [],
              capped: false,
              cap: 200,
            });
          },
          isPending: false,
        }),
      },
    },
  },
}));

import { ApprovalBar } from "../src/components/diff-viewer/ApprovalBar";

const RUN_ID = "00000000-0000-0000-0000-000000000000";

describe("ApprovalBar", () => {
  beforeEach(() => {
    approveMutate.mockReset();
    rejectMutate.mockReset();
    overrideMutate.mockReset();
    bulkApproveMutate.mockReset();
    invalidate.mockReset();
    approveState = { isPending: false };
    rejectState = { isPending: false };
    overrideState = { isPending: false };
    approveOnError = undefined;
  });
  afterEach(() => cleanup());

  it("renders status pill + buttons; Comment toggles the viewer store's commentPanelOpen", async () => {
    const { useViewerStore } =
      await import("../src/components/diff-viewer/useViewerStore");
    // Reset store before the test so we exercise the off→on transition.
    useViewerStore.setState({ commentPanelOpen: false });

    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    expect(screen.getByTestId("approval-bar-status")).toBeDefined();
    expect(screen.getByTestId("run-status-badge-unresolved")).toBeDefined();
    expect(screen.getByTestId("approve-button")).toBeDefined();
    expect(screen.getByTestId("reject-button")).toBeDefined();
    expect(screen.getByTestId("override-button")).toBeDefined();
    const comment = screen.getByTestId("comment-button") as HTMLButtonElement;
    expect(comment.disabled).toBe(false);

    fireEvent.click(comment);
    expect(useViewerStore.getState().commentPanelOpen).toBe(true);
    fireEvent.click(comment);
    expect(useViewerStore.getState().commentPanelOpen).toBe(false);
  });

  it("Approve click invokes the runs.approve mutation with the runId and invalidates the run query", () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    fireEvent.click(screen.getByTestId("approve-button"));
    expect(approveMutate).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(invalidate).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("Reject click invokes the runs.reject mutation with the runId", () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    fireEvent.click(screen.getByTestId("reject-button"));
    expect(rejectMutate).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(invalidate).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("wires onError on the approve mutation hook", () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    // The component must opt into onError so failed mutations surface as
    // visible error text rather than silent no-ops.
    expect(approveOnError).toBeTypeOf("function");
  });

  it("disables Approve / Reject / Override when run is in a non-reviewable state (aborted)", () => {
    render(<ApprovalBar runId={RUN_ID} status="aborted" />);
    const approve = screen.getByTestId("approve-button") as HTMLButtonElement;
    const reject = screen.getByTestId("reject-button") as HTMLButtonElement;
    const override = screen.getByTestId("override-button") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(override.disabled).toBe(true);
    // Clicking the disabled approve must NOT fire the mutation.
    fireEvent.click(approve);
    expect(approveMutate).not.toHaveBeenCalled();
  });

  it.each([["running"], ["new"], ["aborted"], ["empty"]] as const)(
    "disables review controls when status='%s'",
    (status) => {
      render(<ApprovalBar runId={RUN_ID} status={status} />);
      const approve = screen.getByTestId("approve-button") as HTMLButtonElement;
      const reject = screen.getByTestId("reject-button") as HTMLButtonElement;
      const override = screen.getByTestId(
        "override-button",
      ) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      expect(reject.disabled).toBe(true);
      expect(override.disabled).toBe(true);
    },
  );

  it.each([["passed"], ["unresolved"], ["failed"]] as const)(
    "enables review controls when status='%s'",
    (status) => {
      render(<ApprovalBar runId={RUN_ID} status={status} />);
      const approve = screen.getByTestId("approve-button") as HTMLButtonElement;
      const reject = screen.getByTestId("reject-button") as HTMLButtonElement;
      expect(approve.disabled).toBe(false);
      expect(reject.disabled).toBe(false);
    },
  );

  // Radix DropdownMenu trigger fires on pointerdown (mouse button down)
  // rather than `click`, so synthetic `fireEvent.click` on the trigger
  // doesn't open the menu in jsdom. Drive the trigger with the keyboard
  // path instead — pressing Enter on a focused trigger opens the menu.
  const openOverrideMenu = async () => {
    const trigger = screen.getByTestId("override-button") as HTMLButtonElement;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    // Allow Radix to flush its portal mount.
    await new Promise((r) => setTimeout(r, 0));
  };

  it("override dropdown 'Set Passed' calls overrideStatus with status=passed", async () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    await openOverrideMenu();
    const item = await screen.findByTestId("override-set-passed");
    fireEvent.click(item);
    expect(overrideMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: "passed",
    });
  });

  it("override dropdown 'Set Failed' calls overrideStatus with status=failed", async () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    await openOverrideMenu();
    const item = await screen.findByTestId("override-set-failed");
    fireEvent.click(item);
    expect(overrideMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: "failed",
    });
  });

  it("override dropdown 'Default (recompute)' calls overrideStatus with status=default", async () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    await openOverrideMenu();
    const item = await screen.findByTestId("override-set-default");
    fireEvent.click(item);
    expect(overrideMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: "default",
    });
  });

  // Same Radix-keyboard workaround as the Override dropdown above —
  // pointerdown-driven triggers don't open on a synthetic fireEvent.click.
  const openApproveMenu = async () => {
    const trigger = screen.getByTestId(
      "approve-more-menu",
    ) as HTMLButtonElement;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
  };

  it("Approve ▾ → 'Approve all runs of this test' opens the confirm; Approve all fires the bulk mutation", async () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    await openApproveMenu();
    const item = await screen.findByTestId("approve-bulk-variation");
    fireEvent.click(item);
    // Confirm pane appears (not auto-confirmed).
    expect(screen.getByTestId("approve-bulk-confirm")).toBeDefined();
    expect(bulkApproveMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("approve-bulk-confirm-yes"));
    expect(bulkApproveMutate).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(invalidate).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("Approve ▾ confirm Cancel dismisses without firing the mutation", async () => {
    render(<ApprovalBar runId={RUN_ID} status="unresolved" />);
    await openApproveMenu();
    const item = await screen.findByTestId("approve-bulk-variation");
    fireEvent.click(item);
    fireEvent.click(screen.getByTestId("approve-bulk-confirm-no"));
    expect(bulkApproveMutate).not.toHaveBeenCalled();
    // The confirm pane is gone — querying by testId throws when absent;
    // queryByTestId returns null.
    expect(screen.queryByTestId("approve-bulk-confirm")).toBeNull();
  });

  it("hides the Approve ▾ menu when status is not reviewer-actionable", () => {
    render(<ApprovalBar runId={RUN_ID} status="aborted" />);
    expect(screen.queryByTestId("approve-more-menu")).toBeNull();
  });
});
