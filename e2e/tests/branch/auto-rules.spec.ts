import { expect, test } from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

const api = new ApiClient(API);

// Element-map sidecar mapping a selector to the fixture's square (the only area
// `changed` recolors). The diff-worker resolves the auto-rule's selector against
// this to get the bbox the rules-engine matches diff regions against.
const ELEMENT_MAP = JSON.stringify({
  v: 1,
  elements: { "#square": { x: 50, y: 50, width: 100, height: 100 } },
  capturedAt: 1,
});

// The rule selector is resolved against a REAL DOM (jsdom) in the diff-worker,
// then each matched element's SDK cssPath ("#square" for an id'd node) is looked
// up in the element map. So the capture must carry a DOM with a #square element.
const DOM = `<!doctype html><html lang="en"><head><title>t</title></head><body><div id="square"></div></body></html>`;

/**
 * A project auto-rule (selector matcher, action=auto_approve) whose selector
 * resolves — via the uploaded element map — to the square's bbox must
 * auto-resolve the recolor diff, so the changed capture comes back `passed`
 * instead of `unresolved` (which the engines spec confirms is the un-ruled
 * verdict).
 */
test("branch: an auto-rule auto-resolves a known selector-matched diff", async ({}, testInfo) => {
  testInfo.annotations.push(...coverAnnotations(["branch.auto_rule"]));
  const { admin, pat } = ownerCreds();

  const project = await api.createProject(admin, {
    name: `e2e-auto-rule-${Date.now()}`,
  });
  const rule = await api.createAutoRule(admin, {
    projectId: project.id,
    label: "auto-approve #square",
    match: { type: "selector", value: "#square" },
    action: "auto_approve",
  });
  expect(rule.enabled).toBe(true);

  const base = await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "baseline",
    elementMapJson: ELEMENT_MAP,
    domHtml: DOM,
  });
  await api.approveRun(admin, base.runId);

  const changed = await capture(api, {
    pat,
    projectId: project.id,
    branchName: "main",
    checkpointName: "home",
    fixture: "changed",
    elementMapJson: ELEMENT_MAP,
    domHtml: DOM,
  });
  expect(changed.status).toBe("passed");
});
