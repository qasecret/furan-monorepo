import { expect, test } from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";

const API = process.env.E2E_API_URL ?? "http://localhost:3010";

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

  test.beforeAll(async () => {
    const boot = await api.loginJwt(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    admin = boot.token;
    pat = await api.mintPat(admin, "e2e-engines");
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
      expect(changed.status).not.toBe("passed");
      expect(["unresolved", "failed"]).toContain(changed.status);
    });
  }
});
