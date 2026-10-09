import { describe, expect, test } from "vitest";

import {
  checkpointDecisionKindSchema,
  checkpointReviewState,
  checkpointVerdictSchema,
  decisionSnapshotSchema,
  decisionSourceSchema,
  isPending,
  reviewRefusalReasonSchema,
  revertSkipReasonSchema,
  rollupRunStatus,
  runStatusOverrideSchema,
  type CheckpointDecisionKind,
  type CheckpointVerdict,
  type RollupInput,
} from "./review.js";
import type { RunStatus } from "./run-status.js";

type Cp = RollupInput["checkpoints"][number];

/** Build a rollup input for a live (non-terminal-lifecycle) run. */
function input(
  checkpoints: Cp[],
  over: Partial<Omit<RollupInput, "checkpoints">> = {},
): RollupInput {
  return { lifecycle: "running", override: null, checkpoints, ...over };
}

const cp = (
  verdict: CheckpointVerdict | null,
  decision: CheckpointDecisionKind | null = null,
): Cp => ({ verdict, decision });

describe("review enums", () => {
  test("verdict / decision / override values", () => {
    expect(checkpointVerdictSchema.options).toEqual([
      "new",
      "passed",
      "unresolved",
    ]);
    expect(checkpointDecisionKindSchema.options).toEqual([
      "approved",
      "rejected",
    ]);
    expect(runStatusOverrideSchema.options).toEqual(["passed", "failed"]);
  });

  test("decision source / refusal / revert-skip values", () => {
    expect(decisionSourceSchema.options).toEqual([
      "viewer",
      "batch",
      "group",
      "sdk",
      "inbox",
      "backfill",
    ]);
    expect(reviewRefusalReasonSchema.options).toEqual([
      "not_reviewable",
      "run_overridden",
      "already_decided",
      "nothing_to_approve",
      "not_in_run",
    ]);
    expect(revertSkipReasonSchema.options).toEqual([
      "already_undone",
      "not_undoable_legacy",
      "history_corrupt",
      "superseded_newer_capture",
      "superseded_newer_baseline",
      "history_expired",
    ]);
  });
});

describe("checkpointReviewState", () => {
  test("a decision overrides the verdict", () => {
    expect(checkpointReviewState("unresolved", "approved")).toBe("approved");
    expect(checkpointReviewState("new", "approved")).toBe("approved");
    expect(checkpointReviewState("passed", "rejected")).toBe("rejected");
  });

  test("with no decision the verdict is the state", () => {
    expect(checkpointReviewState("new", null)).toBe("new");
    expect(checkpointReviewState("passed", null)).toBe("passed");
    expect(checkpointReviewState("unresolved", null)).toBe("unresolved");
  });
});

describe("isPending", () => {
  test("only new and unresolved are pending", () => {
    expect(isPending("new")).toBe(true);
    expect(isPending("unresolved")).toBe(true);
    expect(isPending("passed")).toBe(false);
    expect(isPending("approved")).toBe(false);
    expect(isPending("rejected")).toBe(false);
  });
});

describe("rollupRunStatus", () => {
  test("rule 1: aborted and empty lifecycles are returned unchanged", () => {
    for (const lifecycle of ["aborted", "empty"] as const) {
      // Even with an override, NULL verdicts or a failing checkpoint.
      expect(rollupRunStatus(input([], { lifecycle }))).toBe(lifecycle);
      expect(rollupRunStatus(input([cp("unresolved")], { lifecycle }))).toBe(
        lifecycle,
      );
      expect(rollupRunStatus(input([cp(null)], { lifecycle }))).toBe(lifecycle);
      expect(
        rollupRunStatus(input([cp("passed", "rejected")], { lifecycle })),
      ).toBe(lifecycle);
      expect(
        rollupRunStatus(
          input([cp("passed")], { lifecycle, override: "failed" }),
        ),
      ).toBe(lifecycle);
      expect(
        rollupRunStatus(input([], { lifecycle, override: "passed" })),
      ).toBe(lifecycle);
    }
  });

  test("rule 2: an override wins over everything else", () => {
    expect(
      rollupRunStatus(
        input([cp("passed"), cp("passed")], { override: "failed" }),
      ),
    ).toBe("failed");
    expect(
      rollupRunStatus(
        input([cp("unresolved"), cp("passed", "rejected")], {
          override: "passed",
        }),
      ),
    ).toBe("passed");
    // Wins over a pending diff (NULL verdict) and over "no checkpoints".
    expect(rollupRunStatus(input([cp(null)], { override: "passed" }))).toBe(
      "passed",
    );
    expect(rollupRunStatus(input([], { override: "failed" }))).toBe("failed");
  });

  test("rule 3: no checkpoints returns the lifecycle", () => {
    const lifecycles: RunStatus[] = [
      "new",
      "running",
      "passed",
      "unresolved",
      "failed",
    ];
    for (const lifecycle of lifecycles) {
      expect(rollupRunStatus(input([], { lifecycle }))).toBe(lifecycle);
    }
    expect(rollupRunStatus(input([], { lifecycle: "unresolved" }))).toBe(
      "unresolved",
    );
  });

  test("rule 4: any NULL verdict means a diff is pending, so running", () => {
    expect(rollupRunStatus(input([cp("passed"), cp(null), cp("passed")]))).toBe(
      "running",
    );
    // Even when other checkpoints would already be failed.
    expect(rollupRunStatus(input([cp("passed", "rejected"), cp(null)]))).toBe(
      "running",
    );
    // Regardless of the stored lifecycle.
    expect(
      rollupRunStatus(input([cp("passed"), cp(null)], { lifecycle: "passed" })),
    ).toBe("running");
  });

  test("rule 5: decisions replace verdicts, then precedence picks the worst", () => {
    // The approved checkpoint counts as passed, so the undecided one decides.
    expect(
      rollupRunStatus(input([cp("unresolved"), cp("unresolved", "approved")])),
    ).toBe("unresolved");
    expect(rollupRunStatus(input([cp("new"), cp("passed")]))).toBe("new");
    expect(
      rollupRunStatus(
        input([cp("unresolved", "approved"), cp("new", "approved")]),
      ),
    ).toBe("passed");
    expect(
      rollupRunStatus(input([cp("passed"), cp("passed", "rejected")])),
    ).toBe("failed");
    // Precedence: unresolved beats new.
    expect(rollupRunStatus(input([cp("unresolved"), cp("new")]))).toBe(
      "unresolved",
    );
    expect(rollupRunStatus(input([cp("new"), cp("unresolved")]))).toBe(
      "unresolved",
    );
    // failed beats everything.
    expect(
      rollupRunStatus(
        input([cp("unresolved"), cp("new"), cp("new", "rejected")]),
      ),
    ).toBe("failed");
  });

  test("rule 5: a single checkpoint maps decisions to passed / failed", () => {
    expect(rollupRunStatus(input([cp("new", "approved")]))).toBe("passed");
    expect(rollupRunStatus(input([cp("unresolved", "approved")]))).toBe(
      "passed",
    );
    expect(rollupRunStatus(input([cp("unresolved", "rejected")]))).toBe(
      "failed",
    );
    expect(rollupRunStatus(input([cp("passed")]))).toBe("passed");
    expect(rollupRunStatus(input([cp("new")]))).toBe("new");
    expect(rollupRunStatus(input([cp("unresolved")]))).toBe("unresolved");
  });

  test("exhaustive truth table: 1-3 checkpoints over verdict x decision", () => {
    const verdicts: Array<CheckpointVerdict | null> = [
      null,
      "new",
      "passed",
      "unresolved",
    ];
    const decisions: Array<CheckpointDecisionKind | null> = [
      null,
      "approved",
      "rejected",
    ];
    const singles: Cp[] = [];
    for (const verdict of verdicts) {
      for (const decision of decisions) singles.push({ verdict, decision });
    }
    expect(singles).toHaveLength(12);

    // Independent oracle, written as plain conditionals rather than a
    // precedence table so it cannot share a bug with the implementation.
    const oracle = (cps: Cp[]): RunStatus => {
      if (cps.some((c) => c.verdict === null)) return "running";
      const states = cps.map((c) => {
        if (c.decision === "approved") return "passed";
        if (c.decision === "rejected") return "failed";
        return c.verdict as CheckpointVerdict;
      });
      if (states.includes("failed")) return "failed";
      if (states.includes("unresolved")) return "unresolved";
      if (states.includes("new")) return "new";
      return "passed";
    };

    const lifecycles: RunStatus[] = [
      "new",
      "running",
      "passed",
      "unresolved",
      "failed",
    ];

    let cases = 0;
    const combos: Cp[][] = [];
    for (const a of singles) {
      combos.push([a]);
      for (const b of singles) {
        combos.push([a, b]);
        for (const c of singles) combos.push([a, b, c]);
      }
    }
    expect(combos).toHaveLength(12 + 144 + 1728);

    for (const checkpoints of combos) {
      const expected = oracle(checkpoints);
      for (const lifecycle of lifecycles) {
        // Stored lifecycle must not influence a live run's rollup.
        expect(
          rollupRunStatus({ lifecycle, override: null, checkpoints }),
          JSON.stringify({ lifecycle, checkpoints }),
        ).toBe(expected);
        cases++;
      }
      // An override always wins, aborted/empty always win over that.
      for (const override of ["passed", "failed"] as const) {
        expect(
          rollupRunStatus({ lifecycle: "running", override, checkpoints }),
        ).toBe(override);
        expect(
          rollupRunStatus({ lifecycle: "aborted", override, checkpoints }),
        ).toBe("aborted");
        expect(
          rollupRunStatus({ lifecycle: "empty", override, checkpoints }),
        ).toBe("empty");
      }
    }
    expect(cases).toBe(combos.length * lifecycles.length);
  });

  test("the rollup is order-independent", () => {
    const a = [cp("passed"), cp("new"), cp("unresolved", "rejected")];
    const b = [...a].reverse();
    expect(rollupRunStatus(input(a))).toBe(rollupRunStatus(input(b)));
    expect(rollupRunStatus(input(a))).toBe("failed");
  });
});

describe("decisionSnapshotSchema", () => {
  const variation = {
    id: "9b1c3d7e-0000-4000-8000-000000000001",
    baselineName: "home-v1.png",
    matchLevel: "strict",
    ignoreRegions: [{ x: 1, y: 2, width: 3, height: 4 }],
    layoutRegions: null,
    floatingRegions: [],
    contentRegions: { anything: "goes" },
    accessibilityRegions: null,
  };
  const prev = {
    baselineName: "home-v0.png",
    userId: "9b1c3d7e-0000-4000-8000-0000000000aa",
    branchName: "main",
    createdAt: "2026-10-09T10:00:00.000Z",
    updatedAt: "2026-10-09T10:05:00.000Z",
  };

  test("accepts an inserted-baseline snapshot", () => {
    const parsed = decisionSnapshotSchema.safeParse({
      baseline: { op: "inserted", id: "b1" },
      variation,
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts an updated-baseline snapshot with its previous row", () => {
    const parsed = decisionSnapshotSchema.safeParse({
      baseline: { op: "updated", id: "b1", prev },
      variation,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.baseline?.op === "updated") {
      expect(parsed.data.baseline.prev.createdAt).toBe(prev.createdAt);
    }
  });

  test("accepts nullable prev fields", () => {
    const parsed = decisionSnapshotSchema.safeParse({
      baseline: {
        op: "updated",
        id: "b1",
        prev: { ...prev, baselineName: null, userId: null },
      },
      variation: { ...variation, baselineName: null },
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts a reject snapshot: no baseline, no variation", () => {
    const parsed = decisionSnapshotSchema.safeParse({
      baseline: null,
      variation: null,
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown baseline op", () => {
    expect(
      decisionSnapshotSchema.safeParse({
        baseline: { op: "moved" },
        variation: null,
      }).success,
    ).toBe(false);
    expect(
      decisionSnapshotSchema.safeParse({
        baseline: { op: "moved" },
        variation,
      }).success,
    ).toBe(false);
  });

  test("rejects structurally broken snapshots", () => {
    // updated without its previous row
    expect(
      decisionSnapshotSchema.safeParse({
        baseline: { op: "updated", id: "b1" },
        variation,
      }).success,
    ).toBe(false);
    // inserted without an id
    expect(
      decisionSnapshotSchema.safeParse({
        baseline: { op: "inserted" },
        variation,
      }).success,
    ).toBe(false);
    // keys omitted entirely
    expect(decisionSnapshotSchema.safeParse({}).success).toBe(false);
    expect(decisionSnapshotSchema.safeParse(null).success).toBe(false);
    // variation missing a required scalar
    const { matchLevel: _omit, ...noMatchLevel } = variation;
    expect(
      decisionSnapshotSchema.safeParse({
        baseline: null,
        variation: noMatchLevel,
      }).success,
    ).toBe(false);
  });
});
