import { rollupRunStatus } from "@furan/shared-types";
import { describe, expect, it } from "vitest";

import {
  applyDecision,
  decidedBy,
  decisionChange,
  pendingDelta,
  patchListedRun,
  restoreChange,
  revertChange,
  revertDecision,
  runStatusFor,
  withPendingDelta,
  type CheckpointItem,
  type RunDetail,
} from "../src/lib/review/optimistic";

const ACTOR = { id: "user-1", name: "Ada" };
const ACTION = "11111111-1111-4111-8111-111111111111";

function item(id: string, over: Partial<CheckpointItem> = {}): CheckpointItem {
  return {
    id,
    name: `step ${id}`,
    viewport: "1280x720",
    browser: "chromium",
    os: "linux",
    matchLevel: "Strict",
    imageKey: "images/a.png",
    testVariationId: "variation-1",
    createdAt: "2026-10-10T00:00:00.000Z",
    verdict: "unresolved",
    state: "unresolved",
    decision: null,
    newerCapture: null,
    status: "unresolved",
    // The legacy alias follows what the item says about itself.
    ...(over.verdict && !over.status && { status: over.verdict }),
    ...(over.state === "approved" && !over.status && { status: "passed" }),
    ...over,
  };
}

const approvedBy = (actionId: string): CheckpointItem["decision"] => ({
  id: `decision-${actionId}`,
  actionId,
  kind: "approved",
  actor: { id: "user-2", name: "Grace" },
  at: "2026-10-10T00:00:00.000Z",
  source: "viewer",
  legacy: false,
  undo: { allowed: true },
});

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
    expect(next[0]?.decision).toMatchObject({
      id: `optimistic:${ACTION}`,
      actionId: ACTION,
      kind: "approved",
      actor: ACTOR,
      source: "viewer",
      legacy: false,
      undo: { allowed: true },
    });
    // The timestamp is a real ISO string, so the chip can render "just now".
    expect(Number.isNaN(Date.parse(next[0]?.decision?.at ?? ""))).toBe(false);
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

describe("the legacy status alias", () => {
  it("follows the patched state, and goes back to the verdict on a revert", () => {
    const items = [item("a"), item("b", { verdict: "new", state: "new" })];

    const approved = applyDecision(
      items,
      new Set(["a"]),
      "approved",
      ACTOR,
      ACTION,
    );
    expect(approved.map((i) => i.status)).toEqual(["passed", "new"]);

    const rejected = applyDecision(
      items,
      new Set(["a", "b"]),
      "rejected",
      ACTOR,
      ACTION,
    );
    expect(rejected.map((i) => i.status)).toEqual(["failed", "failed"]);

    expect(revertDecision(rejected, ACTION).map((i) => i.status)).toEqual([
      "unresolved",
      "new",
    ]);
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

function runDetail(over: Partial<RunDetail> = {}): RunDetail {
  const contexts = {
    a: { verdict: "unresolved", state: "unresolved", decision: null },
    b: { verdict: "unresolved", state: "unresolved", decision: null },
  };
  return {
    id: "run-1",
    buildId: "build-1",
    status: "unresolved",
    statusOverride: null,
    checkpointContexts: contexts,
    ...over,
  } as unknown as RunDetail;
}

describe("decisionChange / revertChange", () => {
  it("patches the contexts of a getById result and recomputes its status", () => {
    const change = decisionChange(new Set(["a"]), "approved", ACTOR, ACTION);

    const one = change.run(runDetail());
    expect(one.checkpointContexts.a).toMatchObject({
      state: "approved",
      decision: { actionId: ACTION },
    });
    expect(one.checkpointContexts.b).toMatchObject({ state: "unresolved" });
    expect(one.status).toBe("unresolved");

    const both = decisionChange(
      new Set(["a", "b"]),
      "approved",
      ACTOR,
      ACTION,
    ).run(runDetail());
    expect(both.status).toBe("passed");
  });

  it("prefers a loaded checkpoint list over the contexts for the status", () => {
    const loaded = [item("a"), item("b", { verdict: "new", state: "new" })];
    const change = decisionChange(
      new Set(["a", "b"]),
      "approved",
      ACTOR,
      ACTION,
    );

    // The contexts say everything is approved; the list is what the caller
    // trusts, and it still has a rejected step.
    const run = change.run(
      runDetail(),
      applyDecision(loaded, new Set(["a"]), "rejected", ACTOR, ACTION),
    );
    expect(run.status).toBe("failed");
  });

  it("reverts the contexts decided by an action", () => {
    const decided = decisionChange(
      new Set(["a", "b"]),
      "approved",
      ACTOR,
      ACTION,
    ).run(runDetail());
    expect(decided.status).toBe("passed");

    const undone = revertChange(ACTION).run(decided);
    expect(undone.checkpointContexts.a).toMatchObject({
      state: "unresolved",
      decision: null,
    });
    expect(undone.status).toBe("unresolved");
  });
});

describe("changes that reach nothing", () => {
  it("hand back the very same list and run", () => {
    const items = [item("a"), item("b")];
    const run = runDetail();

    expect(
      applyDecision(items, new Set(["z"]), "approved", ACTOR, ACTION),
    ).toBe(items);
    expect(revertDecision(items, ACTION)).toBe(items);
    expect(
      decisionChange(new Set(["z"]), "approved", ACTOR, ACTION).run(run),
    ).toBe(run);
    expect(revertChange(ACTION).run(run)).toBe(run);
  });
});

describe("restoreChange / decidedBy", () => {
  it("captures the decisions of an action and puts them back after an undo", () => {
    const decision = approvedBy(ACTION);
    const items = [
      item("a", { state: "approved", decision }),
      item("b"),
      item("c", { state: "approved", decision: approvedBy("other") }),
    ];

    const captured = decidedBy(
      items.map((i) => [i.id, i] as const),
      ACTION,
    );
    expect([...captured.keys()]).toEqual(["a"]);

    const undone = revertDecision(items, ACTION);
    expect(undone[0]).toMatchObject({ state: "unresolved", decision: null });
    expect(restoreChange(captured).items(undone)).toEqual(items);
  });

  it("only touches the checkpoints it captured", () => {
    const current = [
      item("a"),
      item("b", { state: "approved", decision: approvedBy("x") }),
    ];
    const captured = new Map([
      ["a", { state: "approved" as const, decision: approvedBy(ACTION) }],
    ]);

    const next = restoreChange(captured).items(current);

    expect(next[0]).toMatchObject({
      state: "approved",
      decision: { actionId: ACTION },
    });
    expect(next[1]).toBe(current[1]);
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

  it("never lets the build count go below zero", () => {
    const build = { pendingCheckpoints: 1 } as Parameters<
      typeof withPendingDelta
    >[0];

    expect(withPendingDelta(build, -3).pendingCheckpoints).toBe(0);
    expect(withPendingDelta(build, 2).pendingCheckpoints).toBe(3);
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
