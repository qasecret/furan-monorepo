import {
  reviewRefusalReasonSchema,
  revertSkipReasonSchema,
} from "@furan/shared-types";
import { describe, expect, it } from "vitest";

import {
  describeRefusal,
  describeReviewError,
  describeSkip,
} from "../src/lib/review/review-copy";

describe("review copy", () => {
  it("describes every refusal in plain English", () => {
    const expected = {
      not_reviewable: "This run is still processing",
      run_overridden: "Clear the run override to review steps",
      nothing_to_approve: "Nothing pending to approve",
      not_in_run: "This step is not part of the run",
      already_decided: "Already decided — undo it first",
    } as const;

    for (const reason of reviewRefusalReasonSchema.options) {
      expect(describeRefusal(reason)).toBe(expected[reason]);
    }
  });

  it("describes every reason an undo can be skipped", () => {
    const expected = {
      already_undone: "already undone",
      not_undoable_legacy: "decided before review history",
      history_corrupt: "its history can't be read",
      superseded_newer_capture: "a newer capture of this step exists",
      superseded_newer_baseline: "a newer baseline replaced it",
      history_expired: "its baseline was cleaned up",
      superseded_variation_edit: "the step's settings changed since",
    } as const;

    for (const reason of revertSkipReasonSchema.options) {
      expect(describeSkip(reason)).toBe(expected[reason]);
    }
    expect(describeSkip("not_decider")).toBe(
      "only the reviewer who decided or an admin can undo this",
    );
  });
});

describe("describeReviewError", () => {
  const winner = (over: Record<string, unknown> = {}) => ({
    message: "already_decided",
    data: {
      code: "CONFLICT",
      details: {
        winner: {
          checkpointId: "cp-1",
          kind: "approved",
          actorName: "Grace",
          ...over,
        },
      },
    },
  });
  const name = (id: string) => (id === "cp-1" ? "home" : undefined);

  it("names who decided the step first, and what they decided", () => {
    expect(describeReviewError(winner() as never, name)).toBe(
      "Grace already approved home",
    );
    expect(
      describeReviewError(winner({ kind: "rejected" }) as never, name),
    ).toBe("Grace already rejected home");
  });

  it("uses plain words for an unknown person or step", () => {
    expect(
      describeReviewError(
        winner({ actorName: null, checkpointId: "x" }) as never,
        name,
      ),
    ).toBe("Someone already approved this step");
  });

  it("falls back to the refusal text when the winner is missing or malformed", () => {
    const refusal = "Already decided — undo it first";

    expect(
      describeReviewError(
        { message: "already_decided", data: { code: "CONFLICT" } },
        name,
      ),
    ).toBe(refusal);
    expect(
      describeReviewError(winner({ kind: undefined }) as never, name),
    ).toBe(refusal);
    expect(describeReviewError(winner({ kind: "maybe" }) as never, name)).toBe(
      refusal,
    );
  });
});
