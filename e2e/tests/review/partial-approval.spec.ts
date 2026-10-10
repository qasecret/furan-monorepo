import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import {
  captureRun,
  type CaptureRunResult,
} from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

/** The slice of `runs.listCheckpoints` this flow reads. */
interface CheckpointRow {
  id: string;
  name: string;
  state: string | null;
}

/** The slice of `review.approve` / `review.revert` this flow reads. */
interface ReviewOutcome {
  runs: Array<{ runId: string; status: string }>;
}

/**
 * Per-checkpoint approval, end to end against the real stack: a three-step
 * test where only some steps are approved must stay unresolved, the SDK's view
 * of the run must agree with the reviewer's, and undo must give the step back.
 *
 *   baseline run : home, cart, checkout   (approved wholesale → baselines)
 *   candidate run: home changed, cart changed, checkout identical
 *
 * Serial: every step builds on the state the previous one left.
 */
test.describe.serial("review: partial approval and undo", () => {
  const api = new ApiClient(API);
  let admin = ""; // the reviewer (dashboard principal)
  let pat = ""; // the SDK / CI principal
  let projectId = "";
  let candidate: CaptureRunResult;
  let cartActionId = "";

  /** The candidate run's checkpoints as the reviewer sees them, in capture order. */
  const checkpoints = async (): Promise<CheckpointRow[]> =>
    (
      await api.trpcQuery<{ items: CheckpointRow[] }>(
        admin,
        "runs.listCheckpoints",
        { runId: candidate.runId },
      )
    ).items;
  const states = async (): Promise<Array<string | null>> =>
    (await checkpoints()).map((c) => c.state);

  /** What the SDK reads: `GET /runs/:id` with the PAT, as `Furan.snapshot()` polls it. */
  const sdkStatus = async (): Promise<string> =>
    (await api.getRun(pat, candidate.runId)).status;

  test.beforeAll(async () => {
    ({ admin, pat } = ownerCreds());
    const project = await api.createProject(admin, {
      name: `e2e-partial-approval-${Date.now()}`,
    });
    projectId = project.id;
  });

  test("a multi-step baseline run is approved wholesale", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.partial_approval"]));
    const baseline = await captureRun(api, {
      pat,
      projectId,
      branchName: "main",
      checkpoints: [
        { name: "home", fixture: "baseline" },
        { name: "cart", fixture: "baseline" },
        { name: "checkout", fixture: "baseline" },
      ],
    });
    expect(baseline.status).toBe("new");
    expect(Object.keys(baseline.checkpointIds)).toEqual([
      "home",
      "cart",
      "checkout",
    ]);
    await api.approveRun(admin, baseline.runId);
  });

  test("two changed steps and one identical step → the run is unresolved", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.partial_approval"]));
    candidate = await captureRun(api, {
      pat,
      projectId,
      branchName: "main",
      checkpoints: [
        { name: "home", fixture: "changed" },
        { name: "cart", fixture: "changed" },
        { name: "checkout", fixture: "identical" },
      ],
    });
    expect(candidate.status).toBe("unresolved");
    expect(await sdkStatus()).toBe("unresolved");
    // captureRun's ids are the ids the reviewer's read model reports.
    expect((await checkpoints()).map((c) => [c.name, c.id])).toEqual(
      Object.entries(candidate.checkpointIds),
    );
    expect(await states()).toEqual(["unresolved", "unresolved", "passed"]);
  });

  test("approving one of two changed steps leaves the run unresolved, for the SDK too", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.partial_approval"]));
    const result = await api.trpcMutate<ReviewOutcome>(
      admin,
      "review.approve",
      {
        runId: candidate.runId,
        actionId: randomUUID(),
        checkpointIds: [candidate.checkpointIds["home"]!],
      },
    );
    expect(result.runs).toEqual([
      { runId: candidate.runId, status: "unresolved" },
    ]);
    // The SDK would still fail this test: cart is not approved.
    expect(await sdkStatus()).toBe("unresolved");
    expect(await states()).toEqual(["approved", "unresolved", "passed"]);
  });

  test("approving the last changed step resolves the run", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.partial_approval"]));
    cartActionId = randomUUID();
    const result = await api.trpcMutate<ReviewOutcome>(
      admin,
      "review.approve",
      {
        runId: candidate.runId,
        actionId: cartActionId,
        checkpointIds: [candidate.checkpointIds["cart"]!],
      },
    );
    expect(result.runs).toEqual([{ runId: candidate.runId, status: "passed" }]);
    expect(await sdkStatus()).toBe("passed");
    expect(await states()).toEqual(["approved", "approved", "passed"]);
  });

  test("undoing that approval makes the run unresolved again", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.undo"]));
    const result = await api.trpcMutate<ReviewOutcome>(admin, "review.revert", {
      actionId: cartActionId,
    });
    expect(result.runs).toEqual([
      { runId: candidate.runId, status: "unresolved" },
    ]);
    // Undo queues a re-diff of the run. This poll tolerates a transient
    // `running` while that re-diff is in flight (never a fixed sleep). It
    // cannot tell a re-diff that has already landed from one still to come, so
    // it does not prove a later re-diff leaves these verdicts alone.
    const settle = { intervals: [500, 1_000, 2_000], timeout: 30_000 };
    await expect.poll(sdkStatus, settle).toBe("unresolved");
    await expect
      .poll(states, settle)
      .toEqual(["approved", "unresolved", "passed"]);
  });
});
