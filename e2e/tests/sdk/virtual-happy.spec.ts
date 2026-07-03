import { expect, test } from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";


/**
 * The core SDK-trigger → diff-pipeline spine, driven by the virtual-SDK:
 *   first capture → manual first-baseline ("new"),
 *   approve → baseline,
 *   identical → passed,
 *   changed → a real diff ("unresolved").
 * Serial: each step depends on the prior (a baseline must exist before the
 * identical/changed comparisons mean anything).
 */
test.describe.serial("sdk: virtual-SDK happy path", () => {
  const api = new ApiClient(API);
  let admin = "";
  let pat = "";
  let projectId = "";
  let baselineRunId = "";

  test.beforeAll(async () => {
    ({ admin, pat } = ownerCreds()); // owner PAT bypasses membership → captures anywhere
    const project = await api.createProject(admin, {
      name: `e2e-virtual-happy-${Date.now()}`,
    });
    projectId = project.id;
  });

  test("first capture → manual first-baseline (new)", async ({}, testInfo) => {
    testInfo.annotations.push(
      ...coverAnnotations(["sdk.virtual.happy", "branch.first_baseline"]),
    );
    const c = await capture(api, {
      pat,
      projectId,
      branchName: "main",
      checkpointName: "home",
      fixture: "baseline",
    });
    expect(c.status).toBe("new");
    expect(c.autoApproved).toBe(false);
    baselineRunId = c.runId;
  });

  test("approve → identical capture passes", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["diff.identical_passes"]));
    await api.approveRun(admin, baselineRunId);
    const c = await capture(api, {
      pat,
      projectId,
      branchName: "main",
      checkpointName: "home",
      fixture: "identical",
    });
    expect(c.status).toBe("passed");
  });

  test("changed capture → diff (unresolved)", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["sdk.virtual.happy"]));
    const c = await capture(api, {
      pat,
      projectId,
      branchName: "main",
      checkpointName: "home",
      fixture: "changed",
    });
    // Specifically "unresolved" (a detected diff), NOT "failed" (a pipeline
    // error) — so a diff-worker crash can't masquerade as a detected change.
    expect(c.status).toBe("unresolved");
  });
});
