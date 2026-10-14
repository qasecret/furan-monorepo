import type { CheckpointReviewState } from "@furan/shared-types";
import { describe, expect, it } from "vitest";

import {
  deriveReviewHeader,
  type ReviewHeaderInput,
} from "../src/components/diff-viewer/review-header-state";

const STILL_PROCESSING = "This run is still processing";
const ABORTED =
  "This run was aborted before it finished. Re-run the test to review it.";
const EMPTY = "This run recorded no steps. Check the SDK integration.";
const OVERRIDDEN = "Clear the run override to review steps";
const LOCKED = "Clear the run override to change decisions";

const DECIDED: ReadonlyArray<CheckpointReviewState> = ["approved", "rejected"];

/** A reviewable run with one step in `state`. */
function input(
  state: CheckpointReviewState | null = "unresolved",
  over: Partial<ReviewHeaderInput> = {},
): ReviewHeaderInput {
  return {
    status: "unresolved",
    statusOverride: null,
    step: {
      state,
      hasDecision: state === "approved" || state === "rejected",
    },
    stepStates: [state],
    stepInFlight: false,
    runInFlight: false,
    ...over,
  };
}

describe("deriveReviewHeader: the view", () => {
  it.each([
    ["new", "pending"],
    ["unresolved", "pending"],
    ["passed", "machine-passed"],
    ["approved", "decided"],
    ["rejected", "decided"],
  ] as const)(
    "a %s step on a reviewable run shows the %s view",
    (state, view) => {
      const header = deriveReviewHeader(input(state));
      expect(header.view).toBe(view);
      expect(header.disabledReason).toBeNull();
      expect(header.decisionLockedReason).toBeNull();
      expect(header.showRunMenu).toBe(true);
    },
  );

  it("does not call a step decided without a decision to show", () => {
    const header = deriveReviewHeader(
      input("approved", { step: { state: "approved", hasDecision: false } }),
    );
    expect(header.view).not.toBe("decided");
    expect(header.canApprove).toBe(false);
    expect(header.canReject).toBe(false);
  });
});

// Spec §5.4, mirrored: the UI never offers a decision the server refuses.
describe("deriveReviewHeader: what a step may be given", () => {
  it.each([
    ["new", true, true],
    ["unresolved", true, true],
    ["passed", false, true],
    ["approved", false, false],
    ["rejected", false, false],
  ] as const)("a %s step: approve=%s, reject=%s", (state, approve, reject) => {
    const header = deriveReviewHeader(input(state));
    expect(header.canApprove).toBe(approve);
    expect(header.canReject).toBe(reject);
  });

  it("nothing while the step has a decision in flight", () => {
    const header = deriveReviewHeader(
      input("unresolved", { stepInFlight: true }),
    );
    expect(header.canApprove).toBe(false);
    expect(header.canReject).toBe(false);
    expect(header.view).toBe("pending");
  });

  it("nothing for a step the viewer does not know yet", () => {
    const header = deriveReviewHeader(input("unresolved", { step: undefined }));
    expect(header.canApprove).toBe(false);
    expect(header.canReject).toBe(false);
  });
});

describe("deriveReviewHeader: a run with a status override", () => {
  const overridden = (state: CheckpointReviewState | null) =>
    input(state, { status: "failed", statusOverride: "failed" });

  it.each(["new", "unresolved", "passed"] as const)(
    "a %s step: the overridden view, nothing allowed, and the reason",
    (state) => {
      const header = deriveReviewHeader(overridden(state));
      expect(header.view).toBe("overridden");
      expect(header.disabledReason).toBe(OVERRIDDEN);
      expect(header.canApprove).toBe(false);
      expect(header.canReject).toBe(false);
      expect(header.canApprovePendingSteps).toBe(false);
    },
  );

  // R41: a decided step always shows its decision; the override only takes
  // the Undo away.
  it.each(DECIDED)("a %s step keeps its decision, without Undo", (state) => {
    const header = deriveReviewHeader(overridden(state));
    expect(header.view).toBe("decided");
    expect(header.decisionLockedReason).toBe(LOCKED);
  });

  it("keeps the More menu, and lets the override be changed or cleared", () => {
    const header = deriveReviewHeader(overridden("unresolved"));
    expect(header.showRunMenu).toBe(true);
    expect(header.canOverride).toBe(true);
  });

  it("is overridden even for a step that has no verdict yet", () => {
    const header = deriveReviewHeader(
      input(null, { status: "failed", statusOverride: "failed" }),
    );
    expect(header.view).toBe("overridden");
    expect(header.canOverride).toBe(true);
  });
});

describe("deriveReviewHeader: a run that cannot be reviewed", () => {
  it.each([
    ["running", STILL_PROCESSING],
    ["aborted", ABORTED],
    ["empty", EMPTY],
  ] as const)("a %s run says so in its own words", (status, reason) => {
    const header = deriveReviewHeader(input("unresolved", { status }));
    expect(header.view).toBe("not-reviewable");
    expect(header.disabledReason).toBe(reason);
    expect(header.canApprove).toBe(false);
    expect(header.canReject).toBe(false);
    expect(header.canApprovePendingSteps).toBe(false);
    expect(header.showRunMenu).toBe(false);
    expect(header.canOverride).toBe(false);
  });

  // R41, again: a decided step keeps its decision and loses only the Undo.
  it.each([
    ["running", STILL_PROCESSING],
    ["aborted", ABORTED],
    ["empty", EMPTY],
  ] as const)(
    "a decided step on a %s run keeps its decision, and the run's reason why",
    (status, reason) => {
      for (const state of DECIDED) {
        const header = deriveReviewHeader(input(state, { status }));
        expect(header.view).toBe("decided");
        expect(header.decisionLockedReason).toBe(reason);
        expect(header.showRunMenu).toBe(false);
      }
    },
  );

  it("a step still waiting on its diff makes the run 'still processing'", () => {
    const header = deriveReviewHeader(
      input("unresolved", { stepStates: ["unresolved", null] }),
    );
    expect(header.view).toBe("not-reviewable");
    expect(header.disabledReason).toBe(STILL_PROCESSING);
    expect(header.canOverride).toBe(false);
  });

  it("a decided step on such a run keeps its decision", () => {
    const header = deriveReviewHeader(
      input("approved", { stepStates: ["approved", null] }),
    );
    expect(header.view).toBe("decided");
    expect(header.decisionLockedReason).toBe(STILL_PROCESSING);
  });

  it("an aborted run's reason beats a step's missing verdict", () => {
    const header = deriveReviewHeader(
      input(null, { status: "aborted", stepStates: [null] }),
    );
    expect(header.disabledReason).toBe(ABORTED);
  });
});

describe("deriveReviewHeader: the step is not known yet", () => {
  it.each([
    ["the step is not in the list", undefined],
    ["the step has no verdict", { state: null, hasDecision: false }],
  ] as const)("%s: loading, nothing to act on", (_name, step) => {
    const header = deriveReviewHeader(input("unresolved", { step }));
    expect(header.view).toBe("not-reviewable");
    expect(header.disabledReason).toBe(STILL_PROCESSING);
    expect(header.canApprove).toBe(false);
    expect(header.canReject).toBe(false);
    expect(header.showRunMenu).toBe(false);
  });

  it("is a step-level wait only: the run can still be overridden", () => {
    const header = deriveReviewHeader(input("unresolved", { step: undefined }));
    expect(header.canOverride).toBe(true);
  });

  it("works before the step list has loaded", () => {
    const header = deriveReviewHeader(
      input("unresolved", { step: undefined, stepStates: undefined }),
    );
    expect(header.view).toBe("not-reviewable");
    expect(header.pendingSteps).toBe(0);
  });
});

describe("deriveReviewHeader: approve pending steps", () => {
  const states = (...s: Array<CheckpointReviewState | null>) => s;

  it("counts the steps that need a reviewer: new and unresolved", () => {
    const header = deriveReviewHeader(
      input("unresolved", {
        stepStates: states(
          "new",
          "unresolved",
          "passed",
          "approved",
          "rejected",
        ),
      }),
    );
    expect(header.pendingSteps).toBe(2);
    expect(header.canApprovePendingSteps).toBe(true);
  });

  it("is off at zero pending", () => {
    const header = deriveReviewHeader(
      input("approved", { stepStates: states("approved", "passed") }),
    );
    expect(header.pendingSteps).toBe(0);
    expect(header.canApprovePendingSteps).toBe(false);
  });

  it("is off while any step of the run has a decision in flight", () => {
    const header = deriveReviewHeader(
      input("unresolved", { runInFlight: true }),
    );
    expect(header.pendingSteps).toBe(1);
    expect(header.canApprovePendingSteps).toBe(false);
  });
});
