import { expect, test } from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";


test.describe("branch: baseline fallback + merge", () => {
  const api = new ApiClient(API);
  let admin = "";
  let pat = "";

  test.beforeAll(() => {
    ({ admin, pat } = ownerCreds());
  });

  // ADR-054 folds the branch into the test_variation identity, so a feature
  // branch's variation has a DIFFERENT id than main's. resolveBaseline's
  // parent_pr / default_branch tiers now resolve the sibling variation on the
  // target branch by branch-agnostic identity (name/viewport/browser/os/device)
  // and take ITS baseline — previously they queried the candidate's own
  // branch-specific id against another branch and never matched, mislabelling
  // this identical capture as "new".
  test("parent-PR fallback resolves the parent branch's baseline", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["branch.parent_fallback"]));
    const project = await api.createProject(admin, {
      name: `e2e-parent-fallback-${Date.now()}`,
    });
    // Establish a baseline on main.
    const base = await capture(api, {
      pat,
      projectId: project.id,
      branchName: "main",
      checkpointName: "home",
      fixture: "baseline",
    });
    await api.approveRun(admin, base.runId);

    // On a feature branch with no baseline of its own, an identical capture
    // must resolve main's baseline via single-hop parent fallback → passed.
    // (Without fallback it would be a fresh first-baseline → "new".)
    const onFeature = await capture(api, {
      pat,
      projectId: project.id,
      branchName: "feature-1",
      parentBranchName: "main",
      checkpointName: "home",
      fixture: "identical",
    });
    expect(onFeature.status).toBe("passed");
  });

  test("cross-branch merge fans out the source baselines", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["branch.cross_merge"]));
    const project = await api.createProject(admin, {
      name: `e2e-cross-merge-${Date.now()}`,
    });
    const base = await capture(api, {
      pat,
      projectId: project.id,
      branchName: "main",
      checkpointName: "home",
      fixture: "baseline",
    });
    await api.approveRun(admin, base.runId);

    const merged = await api.mergeBranches(admin, project.id, "main", "release");
    expect(typeof merged.buildId).toBe("string");
    expect(merged.runCount).toBeGreaterThanOrEqual(1);
  });
});
