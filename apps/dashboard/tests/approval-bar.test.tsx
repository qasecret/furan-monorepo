import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The review hook is mocked, not the review.* procedures: its own suite
// (use-review-mutations.test.tsx) covers what a decision does to the caches
// and the server. Here: which call the header makes, and when.
const review = vi.hoisted(() => ({
  decide: vi.fn(),
  undo: vi.fn(),
  isInFlight: vi.fn((_id: string) => false),
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => review,
}));

const overrideMutate = vi.fn();
const invalidate = vi.fn();
const invalidateListCheckpoints = vi.fn();
const getCheckpointGroupData = vi.fn();

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// What the two queries the hook reads answer, set per test.
let checkpoints: unknown[] | undefined;
let runData: Record<string, unknown> | undefined;
let overrideState = { isPending: false };
let overrideOnError: ((e: unknown) => void) | undefined;

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      runs: {
        getById: { invalidate },
        listCheckpoints: { invalidate: invalidateListCheckpoints },
      },
    }),
    runs: {
      listCheckpoints: {
        useQuery: () => ({
          data: checkpoints ? { items: checkpoints } : undefined,
          isLoading: false,
          error: null,
        }),
      },
      getById: {
        useQuery: () => ({ data: runData, isLoading: false, error: null }),
      },
      overrideStatus: {
        useMutation: (opts?: {
          onMutate?: () => void;
          onSuccess?: () => void;
          onError?: (e: unknown) => void;
        }) => ({
          mutate: (input: { runId: string; status: string }) => {
            overrideOnError = opts?.onError;
            opts?.onMutate?.();
            overrideMutate(input);
            opts?.onSuccess?.();
          },
          isPending: overrideState.isPending,
        }),
      },
      // The group-approval callout rendered by the standalone bar.
      getCheckpointGroup: {
        useQuery: () => ({
          data: getCheckpointGroupData(),
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));

import { ApprovalBar } from "../src/components/diff-viewer/ApprovalBar";
import {
  useReviewActions,
  type UseReviewActionsArgs,
} from "../src/components/diff-viewer/review-actions";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";
import { useUndoStore } from "../src/lib/review/use-undo-store";

// ApprovalBar renders the actions it's handed; wire them the way DiffViewer
// does — one useReviewActions instance (which the hotkeys also share).
let latestActions: ReturnType<typeof useReviewActions> | undefined;
function Bar(
  props: UseReviewActionsArgs &
    Omit<ComponentProps<typeof ApprovalBar>, "actions">,
) {
  const actions = useReviewActions(props);
  // What a keyboard shortcut would call, for the tests that stand in for one.
  latestActions = actions;
  return <ApprovalBar {...props} actions={actions} />;
}

const RUN_ID = "00000000-0000-0000-0000-000000000000";
const CP = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const step = (over: Record<string, unknown> = {}) => ({
  id: CP,
  name: "home",
  verdict: "unresolved",
  state: "unresolved",
  decision: null,
  newerCapture: null,
  ...over,
});

const decisionOf = (over: Record<string, unknown> = {}) => ({
  id: "decision-1",
  actionId: "action-1",
  kind: "approved",
  actor: { id: "user-1", name: "Grace" },
  at: new Date().toISOString(),
  source: "viewer",
  legacy: false,
  undo: { allowed: true },
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  status: "unresolved",
  statusOverride: null,
  ...over,
});

function arrange({
  items = [step()],
  runOver = {},
}: {
  items?: unknown[];
  runOver?: Record<string, unknown>;
} = {}) {
  checkpoints = items;
  runData = run(runOver);
}

const renderBar = (
  props: Partial<ComponentProps<typeof Bar>> = {},
): ReturnType<typeof render> =>
  render(
    <Bar runId={RUN_ID} checkpointId={CP} status="unresolved" {...props} />,
  );

const button = (testId: string) =>
  screen.getByTestId(testId) as HTMLButtonElement;

/**
 * Whether a control is unavailable: natively disabled, or `aria-disabled`
 * (a disabled control that explains itself stays focusable, so it is the
 * latter; it is still one element).
 */
const unavailable = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled ||
  el.getAttribute("aria-disabled") === "true";

// Radix DropdownMenu trigger fires on pointerdown rather than `click`, so a
// synthetic click doesn't open the menu in jsdom. Pressing Enter on the
// focused trigger does.
const openMoreMenu = async () => {
  const trigger = button("approval-more-menu");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  review.decide.mockReset();
  review.undo.mockReset();
  review.isInFlight.mockReset();
  review.isInFlight.mockReturnValue(false);
  overrideMutate.mockReset();
  invalidate.mockReset();
  invalidateListCheckpoints.mockReset();
  getCheckpointGroupData.mockReset();
  getCheckpointGroupData.mockReturnValue(undefined);
  overrideState = { isPending: false };
  overrideOnError = undefined;
  vi.mocked(toast.error).mockClear();
  useUndoStore.setState({ stack: [] });
  useViewerStore.setState({ commentPanelOpen: false, commentPrefill: null });
  arrange();
});
afterEach(() => cleanup());

describe("ApprovalBar: a step that needs review", () => {
  it("shows More, Mark as Bug, Reject and Approve, and no decision chip", () => {
    renderBar();
    expect(screen.getByTestId("approval-more-menu")).toBeDefined();
    expect(screen.getByTestId("mark-as-bug-button")).toBeDefined();
    expect(screen.getByTestId("reject-button")).toBeDefined();
    expect(button("approve-checkpoint-button").textContent).toBe("Approve");
    expect(screen.queryByTestId("decision-chip")).toBeNull();
    expect(screen.queryByTestId("matches-baseline")).toBeNull();
    // Commenting lives in the sidebar's COMMENTS tab — no Comment button.
    expect(screen.queryByTestId("comment-button")).toBeNull();
  });

  it("reads 'Save as baseline' for a new step", () => {
    arrange({ items: [step({ verdict: "new", state: "new" })] });
    renderBar({ status: "new" });
    expect(button("approve-checkpoint-button").textContent).toBe(
      "Save as baseline",
    );
  });

  it("Approve decides the selected step, by id, and nothing else", () => {
    renderBar();
    fireEvent.click(button("approve-checkpoint-button"));
    expect(review.decide).toHaveBeenCalledTimes(1);
    expect(review.decide).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointIds: [CP],
      kind: "approved",
      label: "Approved 'home'",
    });
  });

  it("Reject decides the selected step as rejected", () => {
    renderBar();
    fireEvent.click(button("reject-button"));
    expect(review.decide).toHaveBeenCalledTimes(1);
    expect(review.decide).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointIds: [CP],
      kind: "rejected",
      label: "Rejected 'home'",
    });
  });

  it("Mark as Bug rejects the selected step only, then opens a pre-filled comment", () => {
    arrange({
      items: [
        step(),
        step({ id: OTHER, name: "pricing", verdict: "new", state: "new" }),
      ],
    });
    renderBar();
    fireEvent.click(button("mark-as-bug-button"));
    expect(review.decide).toHaveBeenCalledTimes(1);
    expect(review.decide).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointIds: [CP],
      kind: "rejected",
      label: "Marked 'home' as a bug",
    });
    expect(useViewerStore.getState().commentPanelOpen).toBe(true);
    // The note is run-scoped, so the prefill names the step it is about.
    expect(useViewerStore.getState().commentPrefill).toBe(
      "Marked 'home' as a bug: ",
    );
  });

  it("folds the viewer's unsaved ignore regions into the approval (ADR-036)", () => {
    useViewerStore.setState({
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
    });
    try {
      arrange({ items: [step({ verdict: "new", state: "new" })] });
      renderBar({ status: "new" });
      fireEvent.click(button("approve-checkpoint-button"));
      expect(review.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpointIds: [CP],
          kind: "approved",
          ignoreAreas: [
            expect.objectContaining({
              x: 10,
              y: 20,
              width: 100,
              height: 50,
              viewport: "1280x720",
              kind: "ignore",
            }),
          ],
        }),
      );
    } finally {
      // Don't leak the draft into sibling tests.
      useViewerStore.setState({ draftIgnoreAreas: [] });
    }
  });

  it("does not send ignore areas the reviewer did not touch", () => {
    renderBar();
    fireEvent.click(button("approve-checkpoint-button"));
    expect(review.decide.mock.calls[0]?.[0]).not.toHaveProperty("ignoreAreas");
  });

  it("disables the three actions while the step has a decision in flight", () => {
    review.isInFlight.mockImplementation((id: string) => id === CP);
    renderBar();
    for (const id of [
      "approve-checkpoint-button",
      "reject-button",
      "mark-as-bug-button",
    ]) {
      expect(unavailable(button(id)), id).toBe(true);
    }
    fireEvent.click(button("approve-checkpoint-button"));
    expect(review.decide).not.toHaveBeenCalled();
  });
});

describe("ApprovalBar: a decided step", () => {
  it("shows the decision chip with Undo for an approval, in place of the action buttons", () => {
    arrange({
      items: [step({ state: "approved", decision: decisionOf() })],
    });
    renderBar();
    const chip = screen.getByTestId("decision-chip");
    expect(chip.textContent).toContain("Approved");
    expect(chip.textContent).toContain("Grace");
    expect(screen.getByTestId("decision-undo")).toBeDefined();
    expect(screen.queryByTestId("approve-checkpoint-button")).toBeNull();
    expect(screen.queryByTestId("reject-button")).toBeNull();
    expect(screen.queryByTestId("mark-as-bug-button")).toBeNull();
  });

  it("shows a rejection the same way", () => {
    arrange({
      items: [
        step({
          state: "rejected",
          decision: decisionOf({ kind: "rejected" }),
        }),
      ],
    });
    renderBar();
    expect(screen.getByTestId("decision-chip").textContent).toContain(
      "Rejected",
    );
    expect(screen.getByTestId("decision-undo")).toBeDefined();
  });

  it("Undo takes back the action that made the decision", () => {
    arrange({
      items: [
        step({
          state: "approved",
          decision: decisionOf({ actionId: "action-7" }),
        }),
      ],
    });
    renderBar();
    fireEvent.click(screen.getByTestId("decision-undo"));
    expect(review.undo).toHaveBeenCalledTimes(1);
    expect(review.undo).toHaveBeenCalledWith("action-7");
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("offers no Undo when the viewer may not undo it", () => {
    arrange({
      items: [
        step({
          state: "approved",
          decision: decisionOf({
            undo: { allowed: false, reason: "not_decider" },
          }),
        }),
      ],
    });
    renderBar();
    expect(screen.getByTestId("decision-chip")).toBeDefined();
    expect(screen.queryByTestId("decision-undo")).toBeNull();
  });

  // Review Focus 5: a decision from before review history has no undo
  // snapshot. It reads as such, offers no Undo, and touches no undo state.
  it("a legacy decision: no Undo, labelled as before review history, undo stack untouched", () => {
    useUndoStore.setState({
      stack: [{ actionId: "earlier", label: "Approved x", runIds: [RUN_ID] }],
    });
    const before = useUndoStore.getState().stack;
    arrange({
      items: [
        step({
          state: "approved",
          decision: decisionOf({
            legacy: true,
            actor: null,
            undo: { allowed: false, reason: "not_undoable_legacy" },
          }),
        }),
      ],
    });
    renderBar();

    const chip = screen.getByTestId("decision-chip");
    expect(chip.textContent).toContain("Approved (before review history)");
    expect(screen.queryByTestId("decision-undo")).toBeNull();
    expect(review.undo).not.toHaveBeenCalled();
    expect(useUndoStore.getState().stack).toBe(before);
  });

  it("disables Undo while the decision is still on its way to the server", () => {
    review.isInFlight.mockImplementation((id: string) => id === CP);
    arrange({
      items: [step({ state: "approved", decision: decisionOf() })],
    });
    renderBar();
    expect(unavailable(button("decision-undo"))).toBe(true);
  });
});

describe("ApprovalBar: a step the machine passed", () => {
  beforeEach(() => {
    arrange({
      items: [step({ verdict: "passed", state: "passed" })],
      runOver: { status: "passed" },
    });
  });

  it("says 'Matches baseline' and offers no Approve", () => {
    renderBar({ status: "passed" });
    expect(screen.getByTestId("matches-baseline").textContent).toBe(
      "Matches baseline",
    );
    expect(screen.queryByTestId("approve-checkpoint-button")).toBeNull();
    expect(screen.queryByTestId("decision-chip")).toBeNull();
  });

  it("keeps 'Reject anyway' in the More menu", async () => {
    renderBar({ status: "passed" });
    await openMoreMenu();
    fireEvent.click(await screen.findByTestId("reject-anyway"));
    expect(review.decide).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointIds: [CP],
      kind: "rejected",
      label: "Rejected 'home'",
    });
  });
});

describe("ApprovalBar: a run with a status override", () => {
  beforeEach(() => {
    arrange({
      runOver: { status: "failed", statusOverride: "failed" },
    });
  });

  it("says so, and offers 'Reset to computed'", () => {
    renderBar({ status: "failed" });
    expect(screen.getByTestId("override-chip").textContent).toContain(
      "Run overridden to Failed",
    );
    expect(button("reset-override").textContent).toBe("Reset to computed");
  });

  it("names a pass override as one", () => {
    arrange({ runOver: { status: "passed", statusOverride: "passed" } });
    renderBar({ status: "passed" });
    expect(screen.getByTestId("override-chip").textContent).toContain(
      "Run overridden to Passed",
    );
  });

  it("'Reset to computed' clears the override", () => {
    renderBar({ status: "failed" });
    fireEvent.click(button("reset-override"));
    expect(overrideMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: "default",
    });
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("disables Approve, Reject and Mark as Bug, and says why", async () => {
    renderBar({ status: "failed" });
    for (const id of [
      "approve-checkpoint-button",
      "reject-button",
      "mark-as-bug-button",
    ]) {
      expect(unavailable(button(id)), id).toBe(true);
    }
    // The unavailable button stays focusable and carries the reason itself.
    const approve = button("approve-checkpoint-button");
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      approve.focus();
    });
    const reason = await screen.findByTestId(
      "approve-checkpoint-button-disabled-reason",
    );
    expect(reason.textContent).toBe("Clear the run override to review steps");
    fireEvent.click(button("approve-checkpoint-button"));
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("shows the override even when a step has not been diffed", () => {
    arrange({
      items: [step({ verdict: null, state: null })],
      runOver: { status: "failed", statusOverride: "failed" },
    });
    renderBar({ status: "failed" });
    expect(screen.getByTestId("override-chip")).toBeDefined();
    expect(unavailable(button("reset-override"))).toBe(false);
  });
});

// R41: a decided step always shows its decision, whatever state the run is in.
// What the run takes away is the Undo, and the chip says why.
describe("ApprovalBar: a decided step on a run that cannot take decisions", () => {
  const approvedStep = (over: Record<string, unknown> = {}) =>
    step({ state: "approved", decision: decisionOf(over) });

  /** The chip's focusable tooltip trigger. */
  const reasonOf = async () => {
    const trigger = screen
      .getByTestId("decision-chip")
      .querySelector("[tabindex]") as HTMLElement;
    await act(async () => {
      trigger.focus();
    });
    return (await screen.findByTestId("decision-undo-reason")).textContent;
  };

  it("overridden run: the override chip, Reset and the decision, with no Undo", async () => {
    arrange({
      items: [approvedStep()],
      runOver: { status: "failed", statusOverride: "failed" },
    });
    renderBar({ status: "failed" });

    expect(screen.getByTestId("override-chip").textContent).toContain(
      "Run overridden to Failed",
    );
    expect(button("reset-override").textContent).toBe("Reset to computed");
    expect(screen.getByTestId("decision-chip").textContent).toContain(
      "Approved",
    );
    expect(screen.queryByTestId("decision-undo")).toBeNull();
    expect(await reasonOf()).toBe("Clear the run override to change decisions");
    // The step buttons are not what a decided step shows.
    expect(screen.queryByTestId("approve-checkpoint-button")).toBeNull();
    expect(screen.queryByTestId("reject-button")).toBeNull();
  });

  it("overridden run: Reset still clears the override", () => {
    arrange({
      items: [approvedStep()],
      runOver: { status: "failed", statusOverride: "failed" },
    });
    renderBar({ status: "failed" });
    fireEvent.click(button("reset-override"));
    expect(overrideMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: "default",
    });
  });

  it("overridden run: a rejection keeps its chip too", () => {
    arrange({
      items: [
        step({
          state: "rejected",
          decision: decisionOf({ kind: "rejected" }),
        }),
      ],
      runOver: { status: "passed", statusOverride: "passed" },
    });
    renderBar({ status: "passed" });
    expect(screen.getByTestId("decision-chip").textContent).toContain(
      "Rejected",
    );
    expect(screen.queryByTestId("decision-undo")).toBeNull();
  });

  it.each([
    ["running", "This run is still processing"],
    [
      "aborted",
      "This run was aborted before it finished. Re-run the test to review it.",
    ],
    ["empty", "This run recorded no steps. Check the SDK integration."],
  ] as const)(
    "%s run: the decision with no Undo, and the run's own reason why",
    async (status, reason) => {
      arrange({ items: [approvedStep()], runOver: { status } });
      renderBar({ status });

      expect(screen.getByTestId("decision-chip").textContent).toContain(
        "Approved",
      );
      expect(screen.queryByTestId("decision-undo")).toBeNull();
      expect(await reasonOf()).toBe(reason);
      expect(screen.queryByTestId("override-chip")).toBeNull();
      expect(screen.queryByTestId("approval-more-menu")).toBeNull();
    },
  );

  it("a run still waiting on another step's diff is a run still processing", async () => {
    arrange({
      items: [approvedStep(), step({ id: OTHER, verdict: null, state: null })],
    });
    renderBar();
    expect(screen.queryByTestId("decision-undo")).toBeNull();
    expect(await reasonOf()).toBe("This run is still processing");
  });

  it("the server's own refusal outranks the run's reason", async () => {
    arrange({
      items: [
        approvedStep({ undo: { allowed: false, reason: "not_decider" } }),
      ],
      runOver: { status: "failed", statusOverride: "failed" },
    });
    renderBar({ status: "failed" });
    expect(await reasonOf()).toBe(
      "Can't undo: only the reviewer who decided or an admin can undo this",
    );
  });

  it("Undo works again on a run that can take decisions", () => {
    arrange({ items: [approvedStep()] });
    renderBar();
    expect(screen.getByTestId("decision-undo")).toBeDefined();
  });
});

describe("ApprovalBar: a run that cannot be reviewed yet", () => {
  it.each([["running"], ["aborted"], ["empty"]] as const)(
    "disables the actions and hides More when the run is %s",
    (status) => {
      arrange({ runOver: { status } });
      renderBar({ status });
      for (const id of [
        "approve-checkpoint-button",
        "reject-button",
        "mark-as-bug-button",
      ]) {
        expect(unavailable(button(id)), id).toBe(true);
      }
      expect(screen.queryByTestId("approval-more-menu")).toBeNull();
      fireEvent.click(button("approve-checkpoint-button"));
      expect(review.decide).not.toHaveBeenCalled();
    },
  );

  it("disables the actions when a step has not been diffed yet", () => {
    arrange({
      items: [step(), step({ id: OTHER, verdict: null, state: null })],
    });
    renderBar();
    expect(unavailable(button("approve-checkpoint-button"))).toBe(true);
    expect(screen.queryByTestId("approval-more-menu")).toBeNull();
  });

  const reasonFor = async (testId: string) => {
    await act(async () => {
      button(testId).focus();
    });
    return (await screen.findByTestId(`${testId}-disabled-reason`)).textContent;
  };

  it.each([
    ["running", "This run is still processing"],
    [
      "aborted",
      "This run was aborted before it finished. Re-run the test to review it.",
    ],
    ["empty", "This run recorded no steps. Check the SDK integration."],
  ] as const)(
    "explains the %s state in its own words",
    async (status, reason) => {
      arrange({ runOver: { status } });
      renderBar({ status });
      expect(await reasonFor("reject-button")).toBe(reason);
    },
  );

  it("calls a step without a verdict 'still processing', whatever the run says", async () => {
    arrange({
      items: [step(), step({ id: OTHER, verdict: null, state: null })],
    });
    renderBar();
    expect(await reasonFor("reject-button")).toBe(
      "This run is still processing",
    );
  });

  // The step list has not resolved yet (the `_first` placeholder), or the
  // selected id is not in the run: nothing to act on, and it says so.
  it.each([
    ["no step selected", undefined],
    ["a step the run does not have", "not-in-the-run"],
  ] as const)(
    "shows the loading state when there is %s",
    async (_name, checkpointId) => {
      renderBar({ checkpointId });
      for (const id of [
        "approve-checkpoint-button",
        "reject-button",
        "mark-as-bug-button",
      ]) {
        expect(unavailable(button(id)), id).toBe(true);
      }
      expect(screen.queryByTestId("approval-more-menu")).toBeNull();
      expect(await reasonFor("approve-checkpoint-button")).toBe(
        "This run is still processing",
      );
    },
  );

  it("shows the loading state for a selected step that has not been diffed", async () => {
    arrange({ items: [step({ verdict: null, state: null })] });
    renderBar();
    expect(unavailable(button("reject-button"))).toBe(true);
    expect(await reasonFor("reject-button")).toBe(
      "This run is still processing",
    );
  });

  it.each([["new"], ["passed"], ["unresolved"], ["failed"]] as const)(
    "enables the actions when the run status is '%s' and the step is pending",
    (status) => {
      renderBar({ status });
      expect(unavailable(button("approve-checkpoint-button"))).toBe(false);
      expect(unavailable(button("reject-button"))).toBe(false);
    },
  );
});

describe("ApprovalBar: the More menu", () => {
  it("'Approve pending steps (N)' decides every pending step, with no ids", async () => {
    arrange({
      items: [
        step(),
        step({ id: OTHER, name: "pricing", verdict: "new", state: "new" }),
        step({
          id: "33333333-3333-4333-8333-333333333333",
          verdict: "passed",
          state: "passed",
        }),
      ],
    });
    renderBar();
    await openMoreMenu();
    const item = await screen.findByTestId("approve-pending-steps");
    expect(item.textContent).toBe("Approve pending steps (2)");
    fireEvent.click(item);
    expect(review.decide).toHaveBeenCalledTimes(1);
    const args = review.decide.mock.calls[0]![0] as {
      label: (r: { decided: unknown[] }) => string;
    };
    expect(args).toMatchObject({ runId: RUN_ID, kind: "approved" });
    expect(args).not.toHaveProperty("checkpointIds");
    // Worded from what the server decided, not from the count shown: a step
    // decided elsewhere meanwhile is not claimed.
    expect(typeof args.label).toBe("function");
    expect(args.label({ decided: [{}] })).toBe("Approved 1 step");
    expect(args.label({ decided: [{}, {}, {}] })).toBe("Approved 3 steps");
  });

  it("is disabled when no step is pending", async () => {
    arrange({
      items: [step({ state: "approved", decision: decisionOf() })],
    });
    renderBar();
    await openMoreMenu();
    const item = await screen.findByTestId("approve-pending-steps");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toBe("Approve pending steps (0)");
    fireEvent.click(item);
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("is disabled under a status override", async () => {
    arrange({ runOver: { status: "failed", statusOverride: "failed" } });
    renderBar({ status: "failed" });
    await openMoreMenu();
    const item = await screen.findByTestId("approve-pending-steps");
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("is disabled while any step of the run has a decision in flight", async () => {
    arrange({ items: [step(), step({ id: OTHER, state: "new" })] });
    review.isInFlight.mockImplementation((id: string) => id === OTHER);
    renderBar();
    await openMoreMenu();
    const item = await screen.findByTestId("approve-pending-steps");
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("offers the run-level overrides, labelled as such, with what they do", async () => {
    renderBar();
    await openMoreMenu();
    expect((await screen.findByTestId("override-set-passed")).textContent).toBe(
      "Force passed (run override)",
    );
    expect(screen.getByTestId("override-set-failed").textContent).toBe(
      "Force failed (run override)",
    );
    expect(screen.getByTestId("override-explainer").textContent).toBe(
      "Sets the run's status directly. Step decisions are kept.",
    );
  });

  it("offers no override on a new run, which the server would refuse", async () => {
    arrange({
      items: [step({ verdict: "new", state: "new" })],
      runOver: { status: "new" },
    });
    renderBar({ status: "new" });
    await openMoreMenu();
    await screen.findByTestId("approve-pending-steps");
    expect(screen.queryByTestId("override-set-passed")).toBeNull();
    expect(screen.queryByTestId("override-set-failed")).toBeNull();
    expect(screen.queryByTestId("override-explainer")).toBeNull();
  });

  it("ties the explanation to every override item, so a screen reader reads it", async () => {
    arrange({ runOver: { status: "failed", statusOverride: "failed" } });
    renderBar({ status: "failed" });
    await openMoreMenu();
    const explainer = await screen.findByTestId("override-explainer");
    expect(explainer.id).not.toBe("");
    for (const id of [
      "override-set-passed",
      "override-set-failed",
      "override-set-default",
    ]) {
      expect(screen.getByTestId(id).getAttribute("aria-describedby"), id).toBe(
        explainer.id,
      );
    }
  });

  it("shows an override that failed in plain words, not the server's message", async () => {
    renderBar();
    await openMoreMenu();
    fireEvent.click(await screen.findByTestId("override-set-passed"));
    expect(overrideOnError).toBeTypeOf("function");

    act(() =>
      overrideOnError?.({
        message: "Cannot override status from 'running'.",
        data: { code: "BAD_REQUEST" },
      }),
    );
    expect(toast.error).toHaveBeenLastCalledWith(
      "The run's status can't be changed from where it is.",
    );

    act(() => overrideOnError?.(new Error("socket hang up")));
    expect(toast.error).toHaveBeenLastCalledWith(
      "Couldn't change the run status. Try again.",
    );
  });

  it("'Force passed' and 'Force failed' set the run override", async () => {
    renderBar();
    await openMoreMenu();
    fireEvent.click(await screen.findByTestId("override-set-passed"));
    expect(overrideMutate).toHaveBeenLastCalledWith({
      runId: RUN_ID,
      status: "passed",
    });
    await openMoreMenu();
    fireEvent.click(await screen.findByTestId("override-set-failed"));
    expect(overrideMutate).toHaveBeenLastCalledWith({
      runId: RUN_ID,
      status: "failed",
    });
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("hides 'Reset to computed' when the run has no override", async () => {
    renderBar();
    await openMoreMenu();
    await screen.findByTestId("override-set-passed");
    expect(screen.queryByTestId("override-set-default")).toBeNull();
  });

  it("offers 'Reset to computed' when the run is overridden", async () => {
    arrange({ runOver: { status: "failed", statusOverride: "failed" } });
    renderBar({ status: "failed" });
    await openMoreMenu();
    const item = await screen.findByTestId("override-set-default");
    expect(item.textContent).toBe("Reset to computed");
    fireEvent.click(item);
    expect(overrideMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      status: "default",
    });
  });

  it("no longer offers the project-wide 'Approve all runs of this test' (ADR-067)", async () => {
    renderBar();
    await openMoreMenu();
    await screen.findByTestId("override-set-passed");
    expect(screen.queryByTestId("approve-bulk-variation")).toBeNull();
  });
});

describe("ApprovalBar: approving an older capture", () => {
  const NEWER = { runId: "run-newer", buildId: "build-2", buildName: "#42" };
  beforeEach(() => {
    arrange({ items: [step({ newerCapture: NEWER })] });
  });

  it("asks first, with the reason and a Cancel that has focus", async () => {
    renderBar();
    fireEvent.click(button("approve-checkpoint-button"));
    expect(review.decide).not.toHaveBeenCalled();

    const dialog = await screen.findByTestId("stale-step-dialog");
    expect(dialog.textContent).toContain("Approve an older capture?");
    expect(dialog.textContent).toContain(
      "A newer capture of this step exists in build #42. Approving here makes this older image the baseline.",
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("stale-step-cancel"),
    );
    expect(screen.getByTestId("stale-step-confirm").textContent).toBe(
      "Approve older capture",
    );
  });

  it("Cancel decides nothing and gives focus back to Approve", async () => {
    renderBar();
    const approve = button("approve-checkpoint-button");
    approve.focus();
    fireEvent.click(approve);
    fireEvent.click(await screen.findByTestId("stale-step-cancel"));

    expect(review.decide).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(document.activeElement).toBe(approve);
  });

  it("returns focus to Approve even where a click does not focus the button", async () => {
    // Safari leaves focus on the page for a button click.
    renderBar();
    const approve = button("approve-checkpoint-button");
    expect(document.activeElement).not.toBe(approve);
    fireEvent.click(approve);
    fireEvent.click(await screen.findByTestId("stale-step-cancel"));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(approve);
  });

  it("opened by a key, returns focus to whatever had it", async () => {
    renderBar();
    const more = button("approval-more-menu");
    more.focus();
    // What the `a` shortcut does: call approve, with no button involved.
    act(() => latestActions?.approve());
    fireEvent.click(await screen.findByTestId("stale-step-cancel"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("a click that did not open the question does not claim focus later", async () => {
    arrange();
    const r = renderBar();
    const approve = button("approve-checkpoint-button");
    fireEvent.click(approve);
    expect(review.decide).toHaveBeenCalledTimes(1);
    // Later the question is opened by a key, with focus elsewhere.
    arrange({ items: [step({ newerCapture: NEWER })] });
    r.rerender(<Bar runId={RUN_ID} checkpointId={CP} status="unresolved" />);
    const more = button("approval-more-menu");
    more.focus();
    act(() => latestActions?.approve());
    fireEvent.click(await screen.findByTestId("stale-step-cancel"));
    await new Promise((res) => setTimeout(res, 0));
    expect(document.activeElement).toBe(more);
  });

  it("Escape also decides nothing", async () => {
    renderBar();
    fireEvent.click(button("approve-checkpoint-button"));
    const dialog = await screen.findByTestId("stale-step-dialog");
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("'Approve older capture' decides the step, once", async () => {
    renderBar();
    fireEvent.click(button("approve-checkpoint-button"));
    fireEvent.click(await screen.findByTestId("stale-step-confirm"));
    expect(review.decide).toHaveBeenCalledTimes(1);
    expect(review.decide).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointIds: [CP],
      kind: "approved",
      label: "Approved 'home'",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
  });

  it("does not ask before rejecting: only an approval makes the image the baseline", () => {
    renderBar();
    fireEvent.click(button("reject-button"));
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(review.decide).toHaveBeenCalledTimes(1);
  });

  it("does not ask when there is no newer capture", () => {
    arrange();
    renderBar();
    fireEvent.click(button("approve-checkpoint-button"));
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(review.decide).toHaveBeenCalledTimes(1);
  });
});

describe("ApprovalBar group-approval callout", () => {
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

  it("renders the callout when a checkpoint is selected and a group exists", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<Bar runId="run-1" checkpointId="c0" />);
    expect(screen.getByTestId("group-approval-callout")).toBeTruthy();
  });

  it("does not render the callout when no checkpoint is selected", () => {
    getCheckpointGroupData.mockReturnValue(GROUP);
    render(<Bar runId="run-1" />);
    expect(screen.queryByTestId("group-approval-callout")).toBeNull();
  });
});

// The actions the hotkeys share with the buttons (DiffViewer passes the same
// object to both). Each must be a no-op when the step's state makes it illegal
// (spec §5.4), so the UI never sends a decision the server would refuse.
describe("useReviewActions", () => {
  const actionsFor = (
    over: Partial<UseReviewActionsArgs> = {},
  ): ReturnType<typeof useReviewActions> =>
    renderHook(() =>
      useReviewActions({
        runId: RUN_ID,
        checkpointId: CP,
        status: "unresolved",
        ...over,
      }),
    ).result.current;

  it.each([
    ["new", true, true],
    ["unresolved", true, true],
    ["passed", false, true],
    ["approved", false, false],
    ["rejected", false, false],
  ] as const)(
    "on a %s step: approve allowed=%s, reject allowed=%s",
    (state, approveAllowed, rejectAllowed) => {
      arrange({
        items: [
          step({
            state,
            decision:
              state === "approved" || state === "rejected"
                ? decisionOf({ kind: state })
                : null,
          }),
        ],
        runOver: { status: state === "passed" ? "passed" : "unresolved" },
      });
      const a = actionsFor();
      a.approve();
      expect(review.decide).toHaveBeenCalledTimes(approveAllowed ? 1 : 0);
      review.decide.mockClear();
      a.reject();
      expect(review.decide).toHaveBeenCalledTimes(rejectAllowed ? 1 : 0);
      review.decide.mockClear();
      a.markAsBug();
      expect(review.decide).toHaveBeenCalledTimes(rejectAllowed ? 1 : 0);
    },
  );

  it("does nothing without a selected step", () => {
    const a = actionsFor({ checkpointId: undefined });
    a.approve();
    a.reject();
    a.markAsBug();
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("does nothing for a step the list does not know", () => {
    const a = actionsFor({ checkpointId: "not-in-the-run" });
    a.approve();
    a.reject();
    expect(review.decide).not.toHaveBeenCalled();
  });

  it("falls back to the run detail's review fields before the list has loaded", () => {
    checkpoints = undefined;
    runData = run({
      checkpointContexts: {
        [CP]: {
          verdict: "unresolved",
          state: "unresolved",
          decision: null,
          newerCapture: null,
        },
      },
    });
    actionsFor().approve();
    expect(review.decide).toHaveBeenCalledTimes(1);
  });

  it("moves on right after it decides, without waiting for the server (R35)", () => {
    const onResolved = vi.fn();
    const order: string[] = [];
    review.decide.mockImplementation(() => order.push("decide"));
    onResolved.mockImplementation(() => order.push("advance"));
    actionsFor({ onResolved }).approve();
    expect(order).toEqual(["decide", "advance"]);
  });

  it("moves on after a rejection, but not after Mark as Bug or a run-wide approval", () => {
    arrange({ items: [step(), step({ id: OTHER })] });
    const onResolved = vi.fn();
    const a = actionsFor({ onResolved });
    a.reject();
    expect(onResolved).toHaveBeenCalledTimes(1);
    // The reviewer is about to write about the step on screen.
    a.markAsBug();
    expect(review.decide).toHaveBeenCalledTimes(2);
    expect(onResolved).toHaveBeenCalledTimes(1);
    a.approveAllCheckpoints();
    expect(review.decide).toHaveBeenCalledTimes(3);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("does not move on when it decided nothing", () => {
    arrange({ items: [step({ state: "approved", decision: decisionOf() })] });
    const onResolved = vi.fn();
    const a = actionsFor({ onResolved });
    a.approve();
    a.reject();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("does not move on until the stale-capture question is answered", () => {
    arrange({
      items: [
        step({
          newerCapture: { runId: "r2", buildId: "b2", buildName: "#2" },
        }),
      ],
    });
    const onResolved = vi.fn();
    const { result } = renderHook(() =>
      useReviewActions({
        runId: RUN_ID,
        checkpointId: CP,
        status: "unresolved",
        onResolved,
      }),
    );
    act(() => result.current.approve());
    expect(onResolved).not.toHaveBeenCalled();
    expect(result.current.staleConfirm.open).toBe(true);
    act(() => result.current.staleConfirm.confirm());
    expect(review.decide).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(result.current.staleConfirm.open).toBe(false);
  });

  it("closes the stale-capture question when the selected step changes", () => {
    arrange({
      items: [
        step({
          newerCapture: { runId: "r2", buildId: "b2", buildName: "#2" },
        }),
        step({ id: OTHER }),
      ],
    });
    const { result, rerender } = renderHook(
      ({ id }) =>
        useReviewActions({
          runId: RUN_ID,
          checkpointId: id,
          status: "unresolved",
        }),
      { initialProps: { id: CP } },
    );
    act(() => result.current.approve());
    expect(result.current.staleConfirm.open).toBe(true);
    rerender({ id: OTHER });
    expect(result.current.staleConfirm.open).toBe(false);
    // Coming back to the step must not re-open the question unprompted.
    rerender({ id: CP });
    expect(result.current.staleConfirm.open).toBe(false);
  });

  it("uses the status argument when given, else the run's own", () => {
    arrange({ runOver: { status: "running" } });
    actionsFor({ status: undefined }).approve();
    expect(review.decide).not.toHaveBeenCalled();
    expect(actionsFor({ status: undefined }).status).toBe("running");
    expect(actionsFor({ status: "unresolved" }).status).toBe("unresolved");
  });
});
