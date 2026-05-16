import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the tRPC client. We stub the mutation hooks directly rather than
// running a real httpBatchLink through a fake fetch — this keeps the test
// asserting *our* component behavior (which mutation is called with which
// input) instead of tRPC's wire format.
const approveMutate = vi.fn();
const rejectMutate = vi.fn();
const invalidate = vi.fn();

let approveState = { isPending: false };
let rejectState = { isPending: false };
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
    },
  },
}));

import { ApprovalBar } from "../src/components/diff-viewer/ApprovalBar";

const RUN_ID = "00000000-0000-0000-0000-000000000000";

describe("ApprovalBar", () => {
  beforeEach(() => {
    approveMutate.mockReset();
    rejectMutate.mockReset();
    invalidate.mockReset();
    approveState = { isPending: false };
    rejectState = { isPending: false };
    approveOnError = undefined;
  });
  afterEach(() => cleanup());

  it("renders three buttons with the Comment button disabled", () => {
    render(<ApprovalBar runId={RUN_ID} />);
    expect(screen.getByTestId("approve-button")).toBeDefined();
    expect(screen.getByTestId("reject-button")).toBeDefined();
    const comment = screen.getByTestId("comment-button") as HTMLButtonElement;
    expect(comment.disabled).toBe(true);
  });

  it("Approve click invokes the runs.approve mutation with the runId and invalidates the run query", () => {
    render(<ApprovalBar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("approve-button"));
    expect(approveMutate).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(invalidate).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("Reject click invokes the runs.reject mutation with the runId", () => {
    render(<ApprovalBar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("reject-button"));
    expect(rejectMutate).toHaveBeenCalledWith({ runId: RUN_ID });
    expect(invalidate).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("wires onError on the approve mutation hook", () => {
    render(<ApprovalBar runId={RUN_ID} />);
    // The component must opt into onError so failed mutations surface as
    // visible error text rather than silent no-ops.
    expect(approveOnError).toBeTypeOf("function");
  });
});
