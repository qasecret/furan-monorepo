import type { ApproveBuildPreview } from "@furan/shared-types";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The review hook and the preview query are mocked: the hook's own suite
// covers what a build approval does, and the server owns the preview. This
// suite covers what the dialog shows, asks and does with their answers.
const { reviewSpies, previewQuery } = vi.hoisted(() => ({
  reviewSpies: {
    decide: vi.fn(),
    undo: vi.fn(),
    approveBuild: vi.fn(),
    decideGroup: vi.fn(),
    isInFlight: vi.fn(() => false),
  },
  previewQuery: vi.fn(),
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => reviewSpies,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    review: {
      previewApproveBuild: {
        useQuery: (...a: unknown[]) => previewQuery(...a),
      },
    },
  },
}));

import { ApprovePendingDialog } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/approve-pending-dialog";
import type { ApproveBuildArgs } from "@/lib/review/use-review-mutations";

const PREVIEW: ApproveBuildPreview = {
  pendingCheckpoints: 37,
  tests: 12,
  rejectedLeftAsIs: 2,
  notReviewableTests: 3,
  capped: false,
  cap: 500,
};

function answer(
  preview: ApproveBuildPreview | undefined,
  over: Record<string, unknown> = {},
) {
  previewQuery.mockReturnValue({
    data: preview,
    isLoading: false,
    isFetching: false,
    isError: false,
    ...over,
  });
}

beforeEach(() => {
  reviewSpies.approveBuild.mockReset();
  previewQuery.mockReset();
  answer(PREVIEW);
});
afterEach(cleanup);

const dialogText = () =>
  screen.getByTestId("approve-pending-dialog").textContent;
const confirm = () =>
  screen.getByTestId("approve-pending-confirm") as HTMLButtonElement;
const cancel = () =>
  screen.getByTestId("approve-pending-cancel") as HTMLButtonElement;

function renderDialog(over: { open?: boolean; onApproved?: () => void } = {}) {
  const onOpenChange = vi.fn();
  const view = render(
    <ApprovePendingDialog
      buildId="b1"
      open={over.open ?? true}
      onOpenChange={onOpenChange}
      onApproved={over.onApproved}
    />,
  );
  return { onOpenChange, ...view };
}

/** What the server answers an approval with: `steps` decided across `runs`. */
function serverResult(steps: number, runs: string[]) {
  return {
    actionId: "a1",
    decided: Array.from({ length: steps }, (_, i) => ({
      checkpointId: `c${i}`,
      runId: runs[i % runs.length]!,
      state: "approved" as const,
    })),
    runs: runs.map((runId) => ({ runId, status: "passed" as const })),
    replayed: false,
    capped: false,
    cap: 500,
  };
}

/** The toast text of an approval, from what the server decided. */
function labelFor(call: ApproveBuildArgs, steps: number, runs: string[]) {
  expect(typeof call.label).toBe("function");
  return (call.label as (r: unknown) => string)(serverResult(steps, runs));
}

/** The arguments of the one `approveBuild` call, to answer the way the hook would. */
function approveCall(): ApproveBuildArgs {
  expect(reviewSpies.approveBuild).toHaveBeenCalledOnce();
  return reviewSpies.approveBuild.mock.calls[0]![0] as ApproveBuildArgs;
}

describe("ApprovePendingDialog copy", () => {
  test("asks about the pending steps, and says what happens to the rest", () => {
    renderDialog();
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Approve 37 pending steps?" }),
    ).toBeDefined();
    const text = dialogText();
    expect(text).toContain(
      "Across 12 tests. Each step's screenshot becomes its baseline.",
    );
    expect(text).toContain("2 rejected steps are left as is.");
    expect(text).toContain(
      "3 tests can't be reviewed right now (still running, aborted, empty or overridden) and are skipped.",
    );
    expect(text).not.toContain("run it again for the rest");
    expect(confirm().textContent).toBe("Approve 37 steps");
  });

  test("counts of one read in the singular", () => {
    answer({
      pendingCheckpoints: 1,
      tests: 1,
      rejectedLeftAsIs: 1,
      notReviewableTests: 1,
      capped: false,
      cap: 500,
    });
    renderDialog();
    expect(
      screen.getByRole("heading", { name: "Approve 1 pending step?" }),
    ).toBeDefined();
    const text = dialogText();
    expect(text).toContain(
      "Across 1 test. Each step's screenshot becomes its baseline.",
    );
    expect(text).toContain("1 rejected step is left as is.");
    expect(text).toContain(
      "1 test can't be reviewed right now (still running, aborted, empty or overridden) and is skipped.",
    );
    expect(confirm().textContent).toBe("Approve 1 step");
  });

  test("leaves out the lines about rejected and running tests when there are none", () => {
    answer({ ...PREVIEW, rejectedLeftAsIs: 0, notReviewableTests: 0 });
    renderDialog();
    const text = dialogText();
    expect(text).not.toContain("rejected");
    expect(text).not.toContain("can't be reviewed");
    expect(text).toContain("Across 12 tests.");
  });

  test("a capped batch says how many it approves, and the button follows", () => {
    answer({ ...PREVIEW, pendingCheckpoints: 812, capped: true, cap: 500 });
    renderDialog();
    expect(
      screen.getByRole("heading", { name: "Approve 812 pending steps?" }),
    ).toBeDefined();
    expect(dialogText()).toContain(
      "Approves the first 500 of 812; run it again for the rest.",
    );
    expect(confirm().textContent).toBe("Approve 500 steps");
  });

  test("says so when nothing is left to approve, and cannot be confirmed", () => {
    answer({ ...PREVIEW, pendingCheckpoints: 0, tests: 0 });
    renderDialog();
    expect(
      screen.getByRole("heading", { name: "Nothing left to approve" }),
    ).toBeDefined();
    expect(confirm().disabled).toBe(true);
  });
});

describe("ApprovePendingDialog loading", () => {
  test("asks for the preview of the build only while open, and never reuses a stale one", () => {
    renderDialog({ open: false });
    expect(previewQuery).toHaveBeenLastCalledWith(
      { buildId: "b1" },
      expect.objectContaining({ enabled: false, staleTime: 0 }),
    );
    cleanup();
    renderDialog({ open: true });
    expect(previewQuery).toHaveBeenLastCalledWith(
      { buildId: "b1" },
      expect.objectContaining({ enabled: true, staleTime: 0 }),
    );
  });

  test("never re-reads the preview on its own while it is open", () => {
    // A window-focus refetch would swap the counts under the reviewer with no
    // notice; the server checks the confirmed count anyway.
    renderDialog();
    expect(previewQuery).toHaveBeenLastCalledWith(
      { buildId: "b1" },
      expect.objectContaining({ refetchOnWindowFocus: false }),
    );
  });

  test("cannot be confirmed before the preview has arrived", () => {
    answer(undefined, { isLoading: true, isFetching: true });
    renderDialog();
    expect(confirm().disabled).toBe(true);
    expect(dialogText()).toContain("Checking what is pending");
    fireEvent.click(confirm());
    expect(reviewSpies.approveBuild).not.toHaveBeenCalled();
  });

  test("shows no old counts, and cannot be confirmed, while fresh ones are on their way", () => {
    // The previous opening's answer is still cached; it must not be shown or
    // confirmed as if it were current.
    answer(PREVIEW, { isFetching: true });
    renderDialog();
    expect(confirm().disabled).toBe(true);
    expect(dialogText()).toContain("Checking what is pending");
    expect(dialogText()).not.toContain("37");
  });

  test("a failed refresh does not bring back the counts of an earlier opening", () => {
    const view = renderDialog();
    expect(dialogText()).toContain("37");
    view.rerender(
      <ApprovePendingDialog
        buildId="b1"
        open={false}
        onOpenChange={view.onOpenChange}
      />,
    );
    // React Query keeps the old data when a refetch fails.
    answer(PREVIEW, { isError: true });
    view.rerender(
      <ApprovePendingDialog
        buildId="b1"
        open={true}
        onOpenChange={view.onOpenChange}
      />,
    );
    expect(dialogText()).not.toContain("37");
    expect(dialogText()).toContain("Couldn't check what is pending");
    expect(confirm().disabled).toBe(true);
  });

  test("says so when the preview cannot be read, and cannot be confirmed", () => {
    answer(undefined, { isError: true });
    renderDialog();
    expect(dialogText()).toContain("Couldn't check what is pending");
    expect(confirm().disabled).toBe(true);
  });
});

describe("ApprovePendingDialog focus", () => {
  test("focus starts on Cancel", async () => {
    renderDialog();
    await waitFor(() => expect(document.activeElement).toBe(cancel()));
  });

  test("closing hands focus back to what opened it", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Approve pending
          </button>
          <ApprovePendingDialog
            buildId="b1"
            open={open}
            onOpenChange={setOpen}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Approve pending" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(cancel()));

    fireEvent.click(cancel());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("closing hands focus to the target it was given, wherever focus was", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const target = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={target} type="button" onClick={() => setOpen(true)}>
            Approve pending
          </button>
          <button type="button">Somewhere else</button>
          <ApprovePendingDialog
            buildId="b1"
            open={open}
            onOpenChange={setOpen}
            returnFocusTo={target}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Approve pending" });
    // Focus is elsewhere when the dialog opens (a click that does not focus its
    // button, as in Safari, or a menu that has already closed).
    screen.getByRole("button", { name: "Somewhere else" }).focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(cancel()));

    fireEvent.click(cancel());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("Cancel closes without approving", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(cancel());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(reviewSpies.approveBuild).not.toHaveBeenCalled();
  });
});

describe("ApprovePendingDialog confirm", () => {
  test("approves the batch it showed, naming the count it confirmed", () => {
    renderDialog();
    fireEvent.click(confirm());
    const call = approveCall();
    expect(call.buildId).toBe("b1");
    expect(call.expectedCount).toBe(37);
    expect(typeof call.onConflict).toBe("function");
  });

  test("a capped batch confirms the whole pending count", () => {
    answer({ ...PREVIEW, pendingCheckpoints: 812, capped: true, cap: 500 });
    renderDialog();
    fireEvent.click(confirm());
    expect(approveCall().expectedCount).toBe(812);
  });

  test("words the toast from what the server decided, not from what was shown", () => {
    renderDialog();
    fireEvent.click(confirm());
    const call = approveCall();
    // The preview said 37 steps in 12 tests; the server decided fewer, because
    // some were decided meanwhile, and the toast says what happened.
    expect(labelFor(call, 35, ["r1", "r2", "r3"])).toBe(
      "Approved 35 steps in 3 tests",
    );
  });

  test("counts a test once however many of its steps were decided", () => {
    renderDialog();
    fireEvent.click(confirm());
    expect(labelFor(approveCall(), 6, ["r1", "r2"])).toBe(
      "Approved 6 steps in 2 tests",
    );
  });

  test("words one step in one test in the singular", () => {
    renderDialog();
    fireEvent.click(confirm());
    expect(labelFor(approveCall(), 1, ["r1"])).toBe(
      "Approved 1 step in 1 test",
    );
  });

  test("waits for the answer: the button is off and a second click asks nothing", () => {
    renderDialog();
    fireEvent.click(confirm());
    expect(confirm().disabled).toBe(true);
    fireEvent.click(confirm());
    expect(reviewSpies.approveBuild).toHaveBeenCalledOnce();
  });

  test("closes once the server has approved, and tells its owner", () => {
    const onApproved = vi.fn();
    const { onOpenChange } = renderDialog({ onApproved });
    fireEvent.click(confirm());
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => {
      approveCall().onSuccess?.();
      approveCall().onSettled?.();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onApproved).toHaveBeenCalledOnce();
  });

  test("cannot be dismissed while the approval is out", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(confirm());

    expect(cancel().disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(cancel());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(confirm().textContent).toBe("Approving…");
  });

  test("can be dismissed again once the approval has failed", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(confirm());
    act(() => approveCall().onSettled?.());

    expect(cancel().disabled).toBe(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("stays open and can be confirmed again after a failure", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(confirm());
    act(() => approveCall().onSettled?.());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(confirm().disabled).toBe(false);
  });
});

describe("ApprovePendingDialog when the batch changed", () => {
  const CHANGED: ApproveBuildPreview = {
    pendingCheckpoints: 40,
    tests: 13,
    rejectedLeftAsIs: 0,
    notReviewableTests: 1,
    capped: false,
    cap: 500,
  };

  function conflict() {
    fireEvent.click(confirm());
    act(() => {
      const call = approveCall();
      call.onConflict(CHANGED);
      call.onSettled?.();
    });
  }

  test("stays open with the new counts in place and says what happened", () => {
    const { onOpenChange } = renderDialog();
    conflict();

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Approve 40 pending steps?" }),
    ).toBeDefined();
    const text = dialogText();
    expect(text).toContain("Across 13 tests.");
    expect(text).not.toContain("rejected");
    expect(text).toContain(
      "1 test can't be reviewed right now (still running, aborted, empty or overridden) and is skipped.",
    );
    expect(confirm().textContent).toBe("Approve 40 steps");
    expect(
      screen.getByText(
        "This batch changed since you opened this; review the new counts.",
      ),
    ).toBeDefined();
  });

  test("announces the notice", () => {
    renderDialog();
    conflict();
    expect(
      screen.getByTestId("approve-pending-conflict").getAttribute("role"),
    ).toBe("alert");
  });

  test("puts the reviewer back on the safe answer", async () => {
    renderDialog();
    fireEvent.click(confirm());
    confirm().focus();
    act(() => {
      const call = approveCall();
      call.onConflict(CHANGED);
      call.onSettled?.();
    });
    await waitFor(() => expect(document.activeElement).toBe(cancel()));
  });

  test("confirms the new count, not the one first shown", () => {
    renderDialog();
    conflict();
    reviewSpies.approveBuild.mockClear();
    fireEvent.click(confirm());
    const call = approveCall();
    expect(call.expectedCount).toBe(40);
  });

  test("a notice is not carried into the next time it opens", () => {
    const view = renderDialog();
    conflict();
    view.rerender(
      <ApprovePendingDialog
        buildId="b1"
        open={false}
        onOpenChange={view.onOpenChange}
      />,
    );
    view.rerender(
      <ApprovePendingDialog
        buildId="b1"
        open={true}
        onOpenChange={view.onOpenChange}
      />,
    );
    expect(screen.queryByTestId("approve-pending-conflict")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Approve 37 pending steps?" }),
    ).toBeDefined();
  });
});
