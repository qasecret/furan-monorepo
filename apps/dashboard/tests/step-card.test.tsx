import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The card is handed `decide` and `undo` by its run list (one review-mutations
// instance per list, not per card); the hook module is only asked whether this
// card's own step has a decision on its way.
const { reviewSpies, inFlight } = vi.hoisted(() => ({
  reviewSpies: { decide: vi.fn(), undo: vi.fn() },
  inFlight: new Set<string>(),
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
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
import { parseReviewContext, type ReviewContext } from "@/lib/review-context";
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
  undiffed: false,
};

/** The review context of a clean URL: Needs review, no facets. */
const CLEAN: ReviewContext = parseReviewContext(new URLSearchParams());

/** Where the Undone toast's Go to takes the reviewer: the step, in the viewer. */
const HOME = { href: "/projects/p1/runs/r1/checkpoints/c1", name: "home" };

function renderCard(
  checkpoint: StepCheckpoint,
  over: { canReview?: boolean; run?: StepRun; ctx?: ReviewContext } = {},
) {
  const card = (cp: StepCheckpoint) => (
    <StepCard
      projectId="p1"
      runId="r1"
      ctx={over.ctx ?? CLEAN}
      canReview={over.canReview ?? true}
      checkpoint={cp}
      index={0}
      total={3}
      run={over.run ?? RUN}
      decide={reviewSpies.decide}
      undo={reviewSpies.undo}
    />
  );
  const view = render(card(checkpoint));
  /** Shows the same card with another checkpoint, as a cache patch would. */
  return { ...view, show: (next: StepCheckpoint) => view.rerender(card(next)) };
}

const button = (testId: string) =>
  screen.getByTestId(testId) as HTMLButtonElement;

/**
 * Whether an action is unavailable: natively disabled, or `aria-disabled` (an
 * unavailable action that can say why stays focusable, so it is the latter).
 */
const unavailable = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled ||
  el.getAttribute("aria-disabled") === "true";

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
      expect(unavailable(button("step-approve-c1"))).toBe(false);
      expect(unavailable(button("step-reject-c1"))).toBe(false);
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
      goTo: HOME,
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
      goTo: HOME,
    });
  });

  test("a card's decision says where its step is, in the page's review context", () => {
    // The Undone toast's Go to opens the step in the viewer, inside the
    // filters the batch page had; the branch and search stay behind.
    const ctx = parseReviewContext(
      new URLSearchParams("status=failed&os=macOS&branch=main&q=nav"),
    );
    renderCard(cp(), { ctx });
    fireEvent.click(button("step-reject-c1"));
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        goTo: {
          href: "/projects/p1/runs/r1/checkpoints/c1?status=failed&os=macOS",
          name: "home",
        },
      }),
    );
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
    expect(unavailable(button("step-approve-c1"))).toBe(true);
    expect(unavailable(button("step-reject-c1"))).toBe(true);
    fireEvent.click(button("step-approve-c1"));
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("Undo waits while its step has a decision on its way", () => {
    inFlight.add("c1");
    renderCard(cp({ state: "approved", decision: decision("approved") }));
    expect(unavailable(button("step-undo-c1"))).toBe(true);
  });

  test("a step in another card's flight is not held up by it", () => {
    inFlight.add("other");
    renderCard(cp());
    expect(unavailable(button("step-approve-c1"))).toBe(false);
  });

  /**
   * An unavailable action says why: it stays one focusable button, marked
   * `aria-disabled`, named after the action and described by the reason, which
   * a tooltip also shows on focus. No second element stands in for it.
   */
  const reasonOf = async (id: string, name: string) => {
    expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    const control = button(id);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.disabled).toBe(false);
    const described = control.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    const text = document.getElementById(described!)?.textContent;
    await act(async () => {
      control.focus();
    });
    const tooltip = await screen.findByTestId(`${id}-disabled-reason`);
    expect(tooltip.textContent).toBe(text);
    return { control, text };
  };

  test("an overridden run makes the step actions unavailable and says why, to the keyboard too", async () => {
    renderCard(cp(), {
      run: { ...RUN, status: "passed", statusOverride: "passed" },
    });
    const approve = await reasonOf("step-approve-c1", "Approve home");
    expect(approve.text).toBe(describeRefusal("run_overridden"));
    const reject = await reasonOf("step-reject-c1", "Reject home");
    expect(reject.text).toBe(describeRefusal("run_overridden"));
  });

  test("an unavailable step action keeps its resting colours on hover", () => {
    // jsdom has no Tailwind: pin the classes. Each icon button rests on
    // `text-fg-muted` and no background, whatever its own hover hue.
    renderCard(cp(), {
      run: { ...RUN, status: "passed", statusOverride: "passed" },
    });
    for (const id of ["step-approve-c1", "step-reject-c1"]) {
      const classes = button(id).className.split(/\s+/);
      expect(classes, id).toContain("aria-disabled:hover:bg-transparent");
      expect(classes, id).toContain("aria-disabled:hover:text-fg-muted");
      // The card's own rest colour replaces the variant's.
      expect(classes, id).not.toContain(
        "aria-disabled:hover:text-fg-secondary",
      );
    }
    // Their hover hues are still there for the available state.
    expect(button("step-approve-c1").className).toContain(
      "hover:text-status-passed-text",
    );
    expect(button("step-reject-c1").className).toContain(
      "hover:text-status-failed-text",
    );
  });

  test("an unavailable Undo keeps its resting colours on hover", () => {
    renderCard(cp({ state: "approved", decision: decision("approved") }), {
      run: { ...RUN, status: "failed", statusOverride: "failed" },
    });
    const classes = button("step-undo-c1").className.split(/\s+/);
    expect(classes).toContain("aria-disabled:hover:bg-transparent");
    expect(classes).toContain("aria-disabled:hover:text-fg-muted");
  });

  test("an unavailable action does nothing when it is used", async () => {
    const user = userEvent.setup();
    renderCard(cp(), {
      run: { ...RUN, status: "passed", statusOverride: "passed" },
    });
    fireEvent.click(button("step-approve-c1"));
    button("step-reject-c1").focus();
    await user.keyboard("{Enter}");
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("an overridden run keeps a decision's Undo off, and says why", async () => {
    renderCard(cp({ state: "approved", decision: decision("approved") }), {
      run: { ...RUN, status: "failed", statusOverride: "failed" },
    });
    const undo = await reasonOf("step-undo-c1", "Undo approval of home");
    expect(undo.text).toBe(DECISIONS_LOCKED_BY_OVERRIDE);
    fireEvent.click(undo.control);
    expect(reviewSpies.undo).not.toHaveBeenCalled();
  });

  test("a run that is not reviewable makes the step actions unavailable and says why", async () => {
    renderCard(cp(), {
      run: { ...RUN, status: "aborted", undiffed: true },
    });
    const approve = await reasonOf("step-approve-c1", "Approve home");
    expect(approve.text).toBe(describeBlockedRun("aborted"));
  });

  test("an available action carries no reason", () => {
    renderCard(cp());
    expect(button("step-approve-c1").hasAttribute("aria-disabled")).toBe(false);
    expect(button("step-approve-c1").hasAttribute("aria-describedby")).toBe(
      false,
    );
  });

  test("a step whose own decision is on its way waits without giving a reason", () => {
    // Held only until the server answers: nothing to explain, so the buttons
    // are plain natively disabled buttons, not explained ones.
    inFlight.add("c1");
    renderCard(cp());
    expect(unavailable(button("step-approve-c1"))).toBe(true);
    expect(unavailable(button("step-reject-c1"))).toBe(true);
    expect(button("step-approve-c1").hasAttribute("aria-disabled")).toBe(false);
    expect(button("step-reject-c1").hasAttribute("aria-disabled")).toBe(false);
  });
});

// M3 (partial): approving an older capture from a step card asks first, with
// the viewer's own stale-step question.
describe("StepCard approve of an older capture", () => {
  const NEWER = { runId: "run-newer", buildId: "build-2", buildName: "#42" };
  const stale = () => cp({ newerCapture: NEWER } as Partial<StepCheckpoint>);

  test("asks before approving, with the viewer's copy, and decides nothing yet", async () => {
    renderCard(stale());
    fireEvent.click(button("step-approve-c1"));
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId("stale-step-dialog");
    expect(dialog.textContent).toContain("Approve an older capture?");
    expect(dialog.textContent).toContain(
      "A newer capture of this step exists in build #42. Approving here makes this older image the baseline.",
    );
  });

  test("Confirm approves this step, once, as the plain Approve would", async () => {
    renderCard(stale());
    fireEvent.click(button("step-approve-c1"));
    fireEvent.click(await screen.findByTestId("stale-step-confirm"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith({
      runId: "r1",
      checkpointIds: ["c1"],
      kind: "approved",
      label: "Approved 'home'",
      goTo: HOME,
    });
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
  });

  test("Cancel decides nothing and gives focus back to Approve", async () => {
    renderCard(stale());
    const approve = button("step-approve-c1");
    approve.focus();
    fireEvent.click(approve);
    fireEvent.click(await screen.findByTestId("stale-step-cancel"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(document.activeElement).toBe(button("step-approve-c1"));
  });

  test("a question left open when the step is decided elsewhere does not come back", async () => {
    const card = renderCard(stale());
    fireEvent.click(button("step-approve-c1"));
    await screen.findByTestId("stale-step-dialog");

    // Another reviewer decides the step: the question goes away with it...
    card.show(
      cp({
        state: "approved",
        decision: decision("approved"),
        newerCapture: NEWER,
      } as Partial<StepCheckpoint>),
    );
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    // ...and the undo makes it pending again: nobody asked, so nothing opens.
    card.show(stale());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("Reject asks nothing: a rejection never makes the older image the baseline", () => {
    renderCard(stale());
    fireEvent.click(button("step-reject-c1"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
  });
});

describe("StepCard focus after a decision", () => {
  const approved = () =>
    cp({ state: "approved", decision: decision("approved") });

  test("keyboard Approve: focus follows to Undo once the decision is settled", async () => {
    const user = userEvent.setup();
    // The hook holds the step while the call is out.
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const card = renderCard(cp());
    button("step-approve-c1").focus();
    await user.keyboard("{Enter}");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();

    // The optimistic patch: approved, the call still out. Undo is there but
    // waiting, and the button that held focus is gone.
    card.show(approved());
    expect(button("step-undo-c1")).toBeDefined();
    expect(document.activeElement).not.toBe(button("step-undo-c1"));

    // The answer is in: Undo can be used, and has focus.
    inFlight.delete("c1");
    card.show(approved());
    expect(document.activeElement).toBe(button("step-undo-c1"));
  });

  test("keyboard Reject: focus follows to Undo rejection", async () => {
    const user = userEvent.setup();
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const card = renderCard(cp());
    button("step-reject-c1").focus();
    await user.keyboard("{Enter}");

    card.show(cp({ state: "rejected", decision: decision("rejected") }));
    inFlight.delete("c1");
    card.show(cp({ state: "rejected", decision: decision("rejected") }));
    expect(document.activeElement).toBe(button("step-undo-c1"));
    expect(button("step-undo-c1").getAttribute("aria-label")).toBe(
      "Undo rejection of home",
    );
  });

  test("when the decision cannot be undone, focus goes to opening the step instead", async () => {
    const user = userEvent.setup();
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const card = renderCard(cp());
    button("step-approve-c1").focus();
    await user.keyboard("{Enter}");

    inFlight.delete("c1");
    card.show(
      cp({
        state: "approved",
        decision: decision("approved", {
          allowed: false,
          reason: "superseded_newer_capture",
        }),
      }),
    );
    expect(screen.queryByTestId("step-undo-c1")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open home in the viewer" }),
    );
  });

  test("when the server refuses, focus is not left on the page", async () => {
    const user = userEvent.setup();
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const card = renderCard(cp());
    button("step-approve-c1").focus();
    await user.keyboard("{Enter}");

    card.show(approved());
    // Rolled back: the step is pending again and the call is over.
    inFlight.delete("c1");
    card.show(cp());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open home in the viewer" }),
    );
  });

  test("a decision made while focus was elsewhere does not take focus", () => {
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const card = renderCard(cp());
    outside.focus();
    fireEvent.click(button("step-approve-c1"));

    card.show(approved());
    inFlight.delete("c1");
    card.show(approved());
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test("a later change to the step, by someone else, does not take focus either", async () => {
    const user = userEvent.setup();
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const card = renderCard(cp());
    button("step-approve-c1").focus();
    await user.keyboard("{Enter}");
    inFlight.delete("c1");
    card.show(approved());
    expect(document.activeElement).toBe(button("step-undo-c1"));

    // Focus moves on; the step is changed again from elsewhere.
    (document.activeElement as HTMLElement).blur();
    card.show(cp());
    card.show(approved());
    expect(document.activeElement).toBe(document.body);
  });
});

describe("StepCard focus after a decision, when the user moves on", () => {
  const approved = () =>
    cp({ state: "approved", decision: decision("approved") });

  test("focus moved elsewhere during the roundtrip stays where the user put it", async () => {
    const user = userEvent.setup();
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const other = document.createElement("button");
    document.body.appendChild(other);
    const card = renderCard(cp());
    button("step-approve-c1").focus();
    await user.keyboard("{Enter}");

    // The user Tabs on to another control while the call is out.
    card.show(approved());
    other.focus();
    inFlight.delete("c1");
    card.show(approved());
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  test("focus on another control of this card's toolbar is still followed to Undo", async () => {
    const user = userEvent.setup();
    reviewSpies.decide.mockImplementation(() => inFlight.add("c1"));
    const card = renderCard(cp());
    button("step-approve-c1").focus();
    await user.keyboard("{Enter}");

    card.show(approved());
    // Still inside the card's own toolbar (the user pressed Tab once).
    screen.getByRole("button", { name: "Open home in the viewer" }).focus();
    inFlight.delete("c1");
    card.show(approved());
    expect(document.activeElement).toBe(button("step-undo-c1"));
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
      run: { ...RUN, status: "aborted", undiffed: true },
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

  test("step cards open the viewer with the review context", () => {
    pushMock.mockClear();
    // The status and the environment facets travel with the card; the Batches
    // page's branch and search do not (spec §3.3).
    const ctx = parseReviewContext(
      new URLSearchParams(
        "status=failed&browser=firefox&viewport=390x844&branch=main&q=nav",
      ),
    );
    renderCard(cp(), { ctx });
    fireEvent.click(screen.getByRole("button", { name: "Open home" }));
    expect(pushMock).toHaveBeenLastCalledWith(
      "/projects/p1/runs/r1/checkpoints/c1?status=failed&browser=firefox&viewport=390x844",
    );
    // The hover toolbar's open action goes to the same place.
    fireEvent.click(
      screen.getByRole("button", { name: "Open home in the viewer" }),
    );
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pushMock).toHaveBeenLastCalledWith(
      "/projects/p1/runs/r1/checkpoints/c1?status=failed&browser=firefox&viewport=390x844",
    );
  });

  test("it is numbered within its row", () => {
    renderCard(cp());
    expect(screen.getByTestId("step-card-c1").textContent).toContain(
      "1/3 home",
    );
  });
});
