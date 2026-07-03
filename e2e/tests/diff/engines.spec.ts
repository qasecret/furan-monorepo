import { expect, test } from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";


const ENGINES = [
  { engine: "odiff", cap: "diff.engine.odiff" },
  { engine: "pixelmatch", cap: "diff.engine.pixelmatch" },
  { engine: "looks_same", cap: "diff.engine.looks_same" },
] as const;

/**
 * Each L1 engine (per-project `imageComparison`) must detect the `changed`
 * fixture as a diff. Baseline → approve → changed, asserting a non-passing
 * verdict, once per engine.
 */
test.describe("diff: L1 engines", () => {
  const api = new ApiClient(API);
  let admin = "";
  let pat = "";

  test.beforeAll(() => {
    ({ admin, pat } = ownerCreds());
  });

  for (const { engine, cap } of ENGINES) {
    test(`${engine} detects the changed fixture`, async ({}, testInfo) => {
      testInfo.annotations.push(...coverAnnotations([cap]));

      const project = await api.createProject(admin, {
        name: `e2e-engine-${engine}-${Date.now()}`,
      });
      await api.setProjectConfig(admin, project.id, { imageComparison: engine });

      const base = await capture(api, {
        pat,
        projectId: project.id,
        branchName: "main",
        checkpointName: "home",
        fixture: "baseline",
      });
      await api.approveRun(admin, base.runId);

      const changed = await capture(api, {
        pat,
        projectId: project.id,
        branchName: "main",
        checkpointName: "home",
        fixture: "changed",
      });
      // Specifically "unresolved" (a detected diff), NOT "failed" (a pipeline
      // error) — so an engine crash can't masquerade as a detected change.
      expect(changed.status).toBe("unresolved");
    });
  }
});
