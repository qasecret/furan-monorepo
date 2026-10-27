import { rollupRunStatus } from "@furan/shared-types";
import { describe, expect, it } from "vitest";

import {
  applyDecision,
  decidedBy,
  decisionChange,
  fieldIds,
  pendingDelta,
  patchListedRun,
  restoreChange,
  revertChange,
  revertDecision,
  runStatusFor,
  withPendingDelta,
  type CheckpointItem,
  type StepDetail,
} from "../src/lib/review/optimistic";

const ACTOR = { id: "user-1", name: "Ada" };
const ACTION = "11111111-1111-4111-8111-111111111111";

/** A step of `runs.listCheckpoints`: what the rail and the step cards draw. */
function item(id: string, over: Partial<CheckpointItem> = {}): CheckpointItem {
  return {
    id,
    name: `step ${id}`,
    viewport: "1280x720",
    browser: "chromium",
    os: "linux",
    device: null,
    imageKey: "images/a.png",
    diffFailedAt: null,
    diffError: null,
    verdict: "unresolved",
    state: "unresolved",
    decision: null,
    newerCapture: null,
    ...over,
  };
}

/** The step list's decision of `actionId`. */
const approvedBy = (actionId: string): CheckpointItem["decision"] => ({
  actionId,
  kind: "approved",
  undo: { allowed: true },
});

/** The step's own read's decision of `actionId`: who and when, too. */
const viewedApprovedBy = (
  actionId: string,
): StepDetail["review"]["decision"] => ({
  id: `decision-${actionId}`,
  actionId,
  kind: "approved",
  actor: { id: "user-2", name: "Grace" },
  at: "2026-10-10T00:00:00.000Z",
  source: "viewer",
  legacy: false,
  undo: { allowed: true },
});

/** A step as `runs.getStep` reads it; only its id and review matter here. */
function stepView(
  id: string,
  review: Partial<StepDetail["review"]> = {},
): StepDetail {
  return {
    step: { id },
    baselineContext: {
      baselineScreenshot: null,
      baselineSource: null,
      variationIgnoreAreas: null,
    },
    regions: [],
    review: {
      verdict: "unresolved",
      state: "unresolved",
      decision: null,
      ...review,
    },
    newerCapture: null,
  } as unknown as StepDetail;
}

describe("applyDecision", () => {
  it("sets state and decision on the targets only", () => {
    const items = [item("a"), item("b"), item("c", { verdict: "new" })];
    const next = applyDecision(
      items,
      new Set(["a", "c"]),
      "approved",
      ACTOR,
      ACTION,
    );

    expect(next.map((i) => i.state)).toEqual([
      "approved",
      "unresolved",
      "approved",
    ]);
    // What the step list's cards draw: the action (an Undo names it), the
    // kind, and that the decider may take it back.
    expect(next[0]?.decision).toEqual({
      actionId: ACTION,
      kind: "approved",
      undo: { allowed: true },
    });
    // The verdict stays: it is what an undo goes back to.
    expect(next[0]?.verdict).toBe("unresolved");
    expect(next[2]?.verdict).toBe("new");
  });

  it("leaves untargeted checkpoints as the same objects", () => {
    const items = [item("a"), item("b")];
    const next = applyDecision(
      items,
      new Set(["a"]),
      "rejected",
      ACTOR,
      ACTION,
    );

    expect(next[0]?.state).toBe("rejected");
    expect(next[1]).toBe(items[1]);
  });

  it("does not mutate its input", () => {
    const items = [item("a")];
    applyDecision(items, new Set(["a"]), "approved", ACTOR, ACTION);

    expect(items[0]?.state).toBe("unresolved");
    expect(items[0]?.decision).toBeNull();
  });
});

describe("revertDecision", () => {
  it("restores the state and clears the decision it applied", () => {
    const items = [item("a"), item("b", { verdict: "new", state: "new" })];
    const applied = applyDecision(
      items,
      new Set(["a", "b"]),
      "approved",
      ACTOR,
      ACTION,
    );

    expect(revertDecision(applied, ACTION)).toEqual(items);
  });

  it("only reverts checkpoints decided by that action", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const items = [
      item("a", { state: "approved", decision: approvedBy(ACTION) }),
      item("b", { state: "approved", decision: approvedBy(other) }),
      item("c"),
    ];
    const next = revertDecision(items, ACTION);

    expect(next[0]).toMatchObject({ state: "unresolved", decision: null });
    expect(next[1]).toBe(items[1]);
    expect(next[2]).toBe(items[2]);
  });

  it("reverts a decision the server reported, not only an optimistic one", () => {
    const items = [
      item("a", { state: "approved", decision: approvedBy(ACTION) }),
    ];

    expect(revertDecision(items, ACTION)[0]).toMatchObject({
      state: "unresolved",
      decision: null,
    });
  });
});

describe("runStatusFor", () => {
  it("matches rollupRunStatus for an [approved, unresolved] list", () => {
    const items = [
      item("a", { state: "approved", decision: approvedBy(ACTION) }),
      item("b"),
    ];

    expect(runStatusFor(items, "unresolved", null)).toBe("unresolved");
    expect(runStatusFor(items, "unresolved", null)).toBe(
      rollupRunStatus({
        lifecycle: "unresolved",
        override: null,
        checkpoints: [
          { verdict: "unresolved", decision: "approved" },
          { verdict: "unresolved", decision: null },
        ],
      }),
    );
  });

  it("is passed once every pending step is approved, failed once one is rejected", () => {
    const approved = applyDecision(
      [item("a"), item("b")],
      new Set(["a", "b"]),
      "approved",
      ACTOR,
      ACTION,
    );
    expect(runStatusFor(approved, "unresolved", null)).toBe("passed");

    const rejected = applyDecision(
      [item("a"), item("b")],
      new Set(["a"]),
      "rejected",
      ACTOR,
      ACTION,
    );
    expect(runStatusFor(rejected, "unresolved", null)).toBe("failed");
  });

  it("lets an override win and keeps an aborted run aborted", () => {
    const items = [item("a")];

    expect(runStatusFor(items, "unresolved", "passed")).toBe("passed");
    expect(runStatusFor(items, "aborted", null)).toBe("aborted");
  });
});

describe("decisionChange / revertChange on a step's own read", () => {
  it("decides the step it reaches, in full: who, when, and that it can be undone", () => {
    const change = decisionChange(new Set(["a"]), "approved", ACTOR, ACTION);

    const a = change.step(stepView("a"));
    expect(a.review).toMatchObject({
      verdict: "unresolved",
      state: "approved",
      decision: {
        id: `optimistic:${ACTION}`,
        actionId: ACTION,
        kind: "approved",
        actor: ACTOR,
        source: "viewer",
        legacy: false,
        undo: { allowed: true },
      },
    });
    // The timestamp is a real ISO string, so the chip can render "just now".
    expect(Number.isNaN(Date.parse(a.review.decision?.at ?? ""))).toBe(false);

    // A step the change does not name is left as it is.
    const b = stepView("b");
    expect(change.step(b)).toBe(b);
  });

  it("reverts the step decided by an action, back to its verdict", () => {
    const decided = decisionChange(
      new Set(["a"]),
      "approved",
      ACTOR,
      ACTION,
    ).step(stepView("a", { verdict: "new", state: "new" }));
    expect(decided.review.state).toBe("approved");

    const undone = revertChange(ACTION).step(decided);
    expect(undone.review).toEqual({
      verdict: "new",
      state: "new",
      decision: null,
    });
    // Another action's decision is not this undo's.
    const other = stepView("a", {
      state: "approved",
      decision: viewedApprovedBy("other"),
    });
    expect(revertChange(ACTION).step(other)).toBe(other);
  });
});

describe("changes that reach nothing", () => {
  it("hand back the very same list and step", () => {
    const items = [item("a"), item("b")];
    const view = stepView("a");

    expect(
      applyDecision(items, new Set(["z"]), "approved", ACTOR, ACTION),
    ).toBe(items);
    expect(revertDecision(items, ACTION)).toBe(items);
    expect(
      decisionChange(new Set(["z"]), "approved", ACTOR, ACTION).step(view),
    ).toBe(view);
    expect(revertChange(ACTION).step(view)).toBe(view);
  });
});

describe("restoreChange / decidedBy", () => {
  it("captures the decisions of an action, in each view, and puts them back after an undo", () => {
    const items = [
      item("a", { state: "approved", decision: approvedBy(ACTION) }),
      item("b"),
      item("c", { state: "approved", decision: approvedBy("other") }),
    ];
    const views = [
      stepView("a", { state: "approved", decision: viewedApprovedBy(ACTION) }),
      stepView("c", { state: "approved", decision: viewedApprovedBy("other") }),
    ];

    const captured = decidedBy(items, views, ACTION);
    expect([...captured.items.keys()]).toEqual(["a"]);
    expect([...captured.steps.keys()]).toEqual(["a"]);
    expect(fieldIds(captured)).toEqual(["a"]);

    const undo = revertChange(ACTION);
    const undone = revertDecision(items, ACTION);
    expect(undone[0]).toMatchObject({ state: "unresolved", decision: null });
    const undoneView = undo.step(views[0]!);
    expect(undoneView.review).toMatchObject({
      state: "unresolved",
      decision: null,
    });

    const restore = restoreChange(captured);
    expect(restore.items(undone)).toEqual(items);
    expect(restore.step(undoneView)).toEqual(views[0]);
  });

  it("only touches the checkpoints it captured", () => {
    const current = [
      item("a"),
      item("b", { state: "approved", decision: approvedBy("x") }),
    ];
    const captured = {
      items: new Map([
        ["a", { state: "approved" as const, decision: approvedBy(ACTION) }],
      ]),
      steps: new Map(),
    };

    const next = restoreChange(captured).items(current);

    expect(next[0]).toMatchObject({
      state: "approved",
      decision: { actionId: ACTION },
    });
    expect(next[1]).toBe(current[1]);
    const untouched = stepView("a");
    expect(restoreChange(captured).step(untouched)).toBe(untouched);
  });
});

describe("pending counts", () => {
  it("counts new and unresolved steps that stop being pending", () => {
    const before = [
      item("a"),
      item("b", { verdict: "new", state: "new" }),
      item("c", { verdict: "passed", state: "passed" }),
    ];
    const after = applyDecision(
      before,
      new Set(["a", "c"]),
      "approved",
      ACTOR,
      ACTION,
    );

    // a was pending, c was not: one fewer pending step.
    expect(pendingDelta(before, after)).toBe(-1);
    expect(pendingDelta(after, before)).toBe(1);
  });

  it("moves the pending and approvable counts together, never below zero", () => {
    const build = {
      pendingCheckpoints: 3,
      approvableCheckpoints: 1,
    } as Parameters<typeof withPendingDelta>[0];

    expect(withPendingDelta(build, -3)).toMatchObject({
      pendingCheckpoints: 0,
      approvableCheckpoints: 0,
    });
    expect(withPendingDelta(build, 2)).toMatchObject({
      pendingCheckpoints: 5,
      approvableCheckpoints: 3,
    });
  });
});

describe("patchListedRun", () => {
  const row = (id: string, status: string) => ({
    id,
    status,
    buildId: "build-1",
  });
  const page = (rows: ReturnType<typeof row>[]) =>
    ({ items: rows, nextCursor: null }) as unknown as Parameters<
      typeof patchListedRun
    >[0];

  it("recomputes the status of the one row for the run", () => {
    const next = patchListedRun(
      page([row("r1", "unresolved"), row("r2", "unresolved")]),
      "r1",
      () => "passed",
    );

    expect(next.items.map((r) => r.status)).toEqual(["passed", "unresolved"]);
  });

  it("returns the page untouched when the row already has that status", () => {
    const original = page([row("r1", "passed")]);

    expect(patchListedRun(original, "r1", () => "passed")).toBe(original);
  });

  it("returns the page untouched when the run is not on it", () => {
    const original = page([row("r2", "unresolved")]);

    expect(patchListedRun(original, "r1", () => "passed")).toBe(original);
  });
});
