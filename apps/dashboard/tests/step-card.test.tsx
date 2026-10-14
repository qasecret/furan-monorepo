import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The review hook is mocked: its own suite covers what a decision does to the
// caches and the server. The card's job is to pick the right call and to
// disable it when the run, or an earlier click, says no.
const { reviewSpies, inFlight } = vi.hoisted(() => ({
  reviewSpies: {
    decide: vi.fn(),
    undo: vi.fn(),
    approveBuild: vi.fn(),
    decideGroup: vi.fn(),
    isInFlight: vi.fn(() => false),
  },
  inFlight: new Set<string>(),
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => reviewSpies,
  useIsInFlight: (id: string) => inFlight.has(id),
}));
vi.mock("@/hooks/use-authed-image", () => ({ useAuthedImage: () => null }));
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import {
  StepCard,
  type StepCheckpoint,
  type StepRun,
} from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/step-card";
import {
  DECISIONS_LOCKED_BY_OVERRIDE,
  describeBlockedRun,
  describeRefusal,
} from "@/lib/review/review-copy";
import { reviewStateStyle, statusStyle } from "@/lib/status-style";

beforeEach(() => {
  reviewSpies.decide.mockReset();
  reviewSpies.undo.mockReset();
  inFlight.clear();
});
afterEach(cleanup);

const decision = (
  kind: "approved" | "rejected",
  undo: { allowed: boolean; reason?: string } = { allowed: true },
): NonNullable<StepCheckpoint["decision"]> =>
  ({
    id: "d1",
    actionId: "action-1",
    kind,
    actor: { id: "u1", name: "Ana" },
    at: new Date().toISOString(),
    source: "viewer",
    legacy: false,
    undo,
  }) as NonNullable<StepCheckpoint["decision"]>;

function cp(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    id: "c1",
    name: "home",
    state: "unresolved",
    decision: null,
    imageKey: "k1",
    ...over,
  };
}

const RUN: StepRun = {
  status: "unresolved",
  statusOverride: null,
  stepStates: ["unresolved"],
};

function renderCard(
  checkpoint: StepCheckpoint,
  over: { canReview?: boolean; run?: StepRun } = {},
) {
  return render(
    <StepCard
      projectId="p1"
      runId="r1"
      canReview={over.canReview ?? true}
      checkpoint={checkpoint}
      index={0}
      total={3}
      run={over.run ?? RUN}
    />,
  );
}

const button = (testId: string) =>
  screen.getByTestId(testId) as HTMLButtonElement;

describe("StepCard review actions", () => {
  test.each(["new", "unresolved"] as const)(
    "a %s step offers Approve and Reject, named after the step",
    (state) => {
      renderCard(cp({ state }));
      expect(
        screen.getByRole("button", { name: "Approve home" }),
      ).toBeDefined();
      expect(screen.getByRole("button", { name: "Reject home" })).toBeDefined();
      expect(screen.queryByTestId("step-undo-c1")).toBeNull();
      expect(button("step-approve-c1").disabled).toBe(false);
      expect(button("step-reject-c1").disabled).toBe(false);
    },
  );

  test("Approve decides this step only, labelled after it", () => {
    renderCard(cp());
    fireEvent.click(button("step-approve-c1"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith({
      runId: "r1",
      checkpointIds: ["c1"],
      kind: "approved",
      label: "Approved 'home'",
    });
  });

  test("Reject decides this step only, labelled after it", () => {
    renderCard(cp());
    fireEvent.click(button("step-reject-c1"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith({
      runId: "r1",
      checkpointIds: ["c1"],
      kind: "rejected",
      label: "Rejected 'home'",
    });
  });

  test("an approved step offers Undo, not Approve or Reject", () => {
    renderCard(cp({ state: "approved", decision: decision("approved") }));
    expect(
      screen.getByRole("button", { name: "Undo approval of home" }),
    ).toBeDefined();
    expect(screen.queryByTestId("step-approve-c1")).toBeNull();
    expect(screen.queryByTestId("step-reject-c1")).toBeNull();
  });

  test("a rejected step offers Undo rejection", () => {
    renderCard(cp({ state: "rejected", decision: decision("rejected") }));
    expect(
      screen.getByRole("button", { name: "Undo rejection of home" }),
    ).toBeDefined();
  });

  test("Undo takes back this step's own decision", () => {
    renderCard(cp({ state: "approved", decision: decision("approved") }));
    fireEvent.click(button("step-undo-c1"));
    expect(reviewSpies.undo).toHaveBeenCalledOnce();
    expect(reviewSpies.undo).toHaveBeenCalledWith("action-1");
  });

  test("a decision the server will not let this reviewer undo has no Undo", () => {
    renderCard(
      cp({
        state: "approved",
        decision: decision("approved", {
          allowed: false,
          reason: "superseded_newer_capture",
        }),
      }),
    );
    expect(screen.queryByTestId("step-undo-c1")).toBeNull();
  });

  test("a step the machine passed, and one still being diffed, have no actions", () => {
    renderCard(cp({ id: "cP", state: "passed" }));
    renderCard(cp({ id: "cN", state: null }));
    for (const id of ["cP", "cN"]) {
      expect(screen.queryByTestId(`step-approve-${id}`)).toBeNull();
      expect(screen.queryByTestId(`step-reject-${id}`)).toBeNull();
      expect(screen.queryByTestId(`step-undo-${id}`)).toBeNull();
    }
  });

  test("a reader who may not review sees no review actions at all", () => {
    renderCard(cp({ id: "cA" }), { canReview: false });
    renderCard(
      cp({ id: "cB", state: "approved", decision: decision("approved") }),
      {
        canReview: false,
      },
    );
    for (const id of ["cA", "cB"]) {
      expect(screen.queryByTestId(`step-approve-${id}`)).toBeNull();
      expect(screen.queryByTestId(`step-reject-${id}`)).toBeNull();
      expect(screen.queryByTestId(`step-undo-${id}`)).toBeNull();
    }
    // Opening the step in the viewer is still there.
    expect(
      screen.getAllByRole("button", { name: "Open home in the viewer" }),
    ).toHaveLength(2);
  });

  test("the buttons wait while this step has a decision on its way", () => {
    inFlight.add("c1");
    renderCard(cp());
    expect(button("step-approve-c1").disabled).toBe(true);
    expect(button("step-reject-c1").disabled).toBe(true);
    fireEvent.click(button("step-approve-c1"));
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("Undo waits while its step has a decision on its way", () => {
    inFlight.add("c1");
    renderCard(cp({ state: "approved", decision: decision("approved") }));
    expect(button("step-undo-c1").disabled).toBe(true);
  });

  test("a step in another card's flight is not held up by it", () => {
    inFlight.add("other");
    renderCard(cp());
    expect(button("step-approve-c1").disabled).toBe(false);
  });

  /**
   * A disabled action sits in a focusable wrapper that carries its reason: the
   * wrapper is named after the action, and is described by the reason, so a
   * keyboard or screen-reader user gets it, not only a mouse hover.
   */
  const reasonOf = async (id: string) => {
    const wrapper = screen.getByTestId(`${id}-disabled-wrapper`);
    expect(wrapper.tabIndex).toBe(0);
    expect(wrapper.getAttribute("role")).toBe("button");
    expect(wrapper.getAttribute("aria-disabled")).toBe("true");
    const described = wrapper.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    const text = document.getElementById(described!)?.textContent;
    // Focusing it also shows the reason as a tooltip.
    await act(async () => {
      wrapper.focus();
    });
    const tooltip = await screen.findByTestId(`${id}-disabled-reason`);
    expect(tooltip.textContent).toBe(text);
    return { wrapper, text };
  };

  test("an overridden run disables the step actions and says why, to the keyboard too", async () => {
    renderCard(cp(), {
      run: { ...RUN, status: "passed", statusOverride: "passed" },
    });
    for (const id of ["step-approve-c1", "step-reject-c1"]) {
      expect(button(id).disabled).toBe(true);
      const { text } = await reasonOf(id);
      expect(text).toBe(describeRefusal("run_overridden"));
    }
    const { wrapper } = await reasonOf("step-approve-c1");
    expect(wrapper.getAttribute("aria-label")).toBe("Approve home");
    expect(button("step-approve-c1").getAttribute("aria-label")).toBe(
      "Approve home",
    );
  });

  test("an overridden run keeps a decision's Undo off, and says why", async () => {
    renderCard(cp({ state: "approved", decision: decision("approved") }), {
      run: { ...RUN, status: "failed", statusOverride: "failed" },
    });
    expect(button("step-undo-c1").disabled).toBe(true);
    const { wrapper, text } = await reasonOf("step-undo-c1");
    expect(text).toBe(DECISIONS_LOCKED_BY_OVERRIDE);
    expect(wrapper.getAttribute("aria-label")).toBe("Undo approval of home");
  });

  test("a run that is not reviewable disables the step actions and says why", async () => {
    renderCard(cp(), {
      run: { ...RUN, status: "aborted", stepStates: ["unresolved", null] },
    });
    expect(button("step-approve-c1").disabled).toBe(true);
    const { text } = await reasonOf("step-approve-c1");
    expect(text).toBe(describeBlockedRun("aborted"));
  });

  test("an enabled action has no wrapper and no reason", () => {
    renderCard(cp());
    expect(screen.queryByTestId("step-approve-c1-disabled-wrapper")).toBeNull();
    expect(button("step-approve-c1").title).toBe("");
  });

  test("a step whose own decision is on its way waits without giving a reason", () => {
    // Held only until the server answers: nothing to explain, so the buttons
    // are plain disabled buttons, not reason-carrying wrappers.
    inFlight.add("c1");
    renderCard(cp());
    expect(button("step-approve-c1").disabled).toBe(true);
    expect(button("step-reject-c1").disabled).toBe(true);
    expect(screen.queryByTestId("step-approve-c1-disabled-wrapper")).toBeNull();
    expect(screen.queryByTestId("step-reject-c1-disabled-wrapper")).toBeNull();
    expect(button("step-approve-c1").title).toBe("");
  });
});

describe("StepCard state", () => {
  test.each([
    ["new", null],
    ["unresolved", null],
    ["passed", null],
    ["approved", decision("approved")],
    ["rejected", decision("rejected")],
  ] as const)(
    "a %s step takes its icon, label and accent from the review state",
    (state, dec) => {
      const style = reviewStateStyle(state);
      renderCard(cp({ state, decision: dec }));
      const status = screen.getByTestId("step-status-c1");
      expect(status.textContent).toBe(style.label);
      expect(status.getAttribute("title")).toBe(style.tooltip);
      expect(status.querySelector("svg")).not.toBeNull();
      const accent = screen.getByTestId("step-accent-c1");
      for (const cls of style.dot.split(" ")) {
        expect(accent.classList.contains(cls)).toBe(true);
      }
    },
  );

  test("a step still being diffed reads as running", () => {
    renderCard(cp({ state: null }));
    expect(screen.getByTestId("step-status-c1").textContent).toBe(
      statusStyle("running").label,
    );
  });

  test("a step the run never diffed reads as the run's end, not as running", () => {
    renderCard(cp({ state: null }), {
      run: { ...RUN, status: "aborted", stepStates: [null] },
    });
    expect(screen.getByTestId("step-status-c1").textContent).toBe(
      statusStyle("aborted").label,
    );
  });
});

describe("StepCard layout", () => {
  test("the hover toolbar is findable by id and holds the open action", () => {
    renderCard(cp());
    const toolbar = screen.getByTestId("step-toolbar-c1");
    expect(toolbar.className).toContain("opacity-0");
    expect(toolbar.className).toContain("group-hover:opacity-100");
    expect(
      toolbar.contains(
        screen.getByRole("button", { name: "Open home in the viewer" }),
      ),
    ).toBe(true);
  });

  test("opening the step goes to the viewer", () => {
    pushMock.mockClear();
    renderCard(cp());
    fireEvent.click(screen.getByRole("button", { name: "Open home" }));
    expect(pushMock).toHaveBeenCalledWith(
      "/projects/p1/runs/r1/checkpoints/c1",
    );
  });

  test("it is numbered within its row", () => {
    renderCard(cp());
    expect(screen.getByTestId("step-card-c1").textContent).toContain(
      "1/3 home",
    );
  });
});
