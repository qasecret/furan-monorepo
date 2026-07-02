import { expect, test } from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";

const API = process.env.E2E_API_URL ?? "http://localhost:3010";

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
    const boot = await api.loginJwt(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    admin = boot.token;
    pat = await api.mintPat(admin, "e2e-virtual-happy");
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
    expect(c.status).not.toBe("passed");
    expect(["unresolved", "failed"]).toContain(c.status);
  });
});
