import { expect, test } from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

const api = new ApiClient(API);

// Element-map + DOM mapping the fixture square to #square (see auto-rules spec).
const SQUARE_MAP = JSON.stringify({
  v: 1,
  elements: { "#square": { x: 50, y: 50, width: 100, height: 100 } },
  capturedAt: 1,
});
const SQUARE_DOM = `<!doctype html><html lang="en"><head><title>t</title></head><body><div id="square"></div></body></html>`;

/**
 * An ignore region drawn over the changed area (persisted onto the variation at
 * approve time, ADR-036) must mask that box, so an otherwise-failing changed
 * capture comes back `passed`.
 *
 * The fixtures are 400x300 with a 100x100 square at (50,50); `changed` only
 * recolors that square, so an ignore box covering it suppresses the whole diff.
 */
test("diff: an ignore region suppresses a masked-area change", async ({}, testInfo) => {
  testInfo.annotations.push(...coverAnnotations(["diff.ignore_region"]));
  const { admin, pat } = ownerCreds();

  const project = await api.createProject(admin, {
    name: `e2e-ignore-region-${Date.now()}`,
  });

  // Baseline, then approve WITH an ignore box over the square.
  const base = await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "baseline",
  });
  await api.approveRunWithIgnore(admin, base.runId, [
    { x: 40, y: 40, width: 120, height: 120, viewport: "400x300", mode: "ignore" },
  ]);

  // The changed square falls entirely inside the ignore box → masked → passed.
  const changed = await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "changed",
  });
  expect(changed.status).toBe("passed");
});

// Layout suppression is element-map-based (ADR-053; matchLevel no longer routes
// the L1 diff per configForMatchLevel). With the #square element mapped + the
// DOM present, a Layout-level capture suppresses the content-only recolor.
test("diff: Layout match-level tolerates a content-only change", async ({}, testInfo) => {
  testInfo.annotations.push(...coverAnnotations(["diff.layout_match"]));
  const { admin, pat } = ownerCreds();

  const project = await api.createProject(admin, {
    name: `e2e-layout-${Date.now()}`,
  });
  const base = await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "baseline",
    matchLevel: "Layout",
    elementMapJson: SQUARE_MAP,
    domHtml: SQUARE_DOM,
  });
  await api.approveRun(admin, base.runId);

  // `changed` recolors the square but keeps its position/size — a content-only
  // change the Layout level suppresses for the mapped element → passed.
  const changed = await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "changed",
    matchLevel: "Layout",
    elementMapJson: SQUARE_MAP,
    domHtml: SQUARE_DOM,
  });
  expect(changed.status).toBe("passed");
});

// DEFERRED (region observability): the multipart a11y path works (domHtml +
// accessibilityLevel/Version upload → the diff-worker runs axe over the DOM and
// records source='axe' diff_regions), but there's no REST endpoint to READ a
// run's regions — GET /runs/:id omits them and there's no /regions or
// /checkpoints route. Asserting the axe regions surfaced needs the dashboard's
// tRPC region query (+ the exact wire shape) and clear status semantics for an
// a11y-only finding. Wire that read path, then un-skip.
test.skip("diff: axe a11y surfaces accessibility regions", async ({}, testInfo) => {
  testInfo.annotations.push(...coverAnnotations(["diff.axe_a11y"]));
  const { admin, pat } = ownerCreds();
  const project = await api.createProject(admin, {
    name: `e2e-a11y-${Date.now()}`,
  });
  const dom =
    "<!doctype html><html lang='en'><head><title>t</title></head>" +
    "<body><img src='x.png'><button></button></body></html>";
  const run = await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "baseline",
    domHtml: dom,
    accessibilityLevel: "AA",
    accessibilityVersion: "WCAG_2_1",
  });
  // TODO: assert source='axe' regions once a region-read path is available.
  expect(run.runId).toBeTruthy();
});
