import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ApiClient } from "./api-client.js";

/**
 * Virtual SDK: replays the Furan SDK's REST wire flow from TypeScript so the
 * diff pipeline can be driven fast + deterministically:
 *   create build → create run → upload screenshot (base64) → complete → POLL.
 *
 * Polling is essential: `/complete` returns a premature rollup that is never
 * `running`, so the diff pipeline (diff-worker) owns the terminal
 * `test_runs.status`. We wait for it to settle rather than trusting the
 * immediate rollup — exactly what the real SDK must do.
 */

export type Fixture = "baseline" | "identical" | "changed";

const FIX_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

function pngBase64(fixture: Fixture): string {
  return readFileSync(`${FIX_DIR}${fixture}.png`).toString("base64");
}

/** Statuses that mean "the diff pipeline is still working". */
const NON_TERMINAL = new Set(["running", "pending", "queued", "processing"]);

export interface CaptureInput {
  pat: string;
  projectId: string;
  branchName: string;
  checkpointName: string;
  fixture: Fixture;
  buildName?: string;
  viewport?: string;
  browser?: string;
  parentBranchName?: string;
  elementMapJson?: string;
  domHtml?: string;
}

export interface CaptureResult {
  buildId: string;
  runId: string;
  status: string;
  autoApproved: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Poll `GET /runs/:id` until the status leaves the non-terminal set AND stays
 * stable across two reads (so a premature rollup that the diff-worker then
 * overwrites isn't mistaken for the verdict), or until `timeoutMs`.
 */
export async function pollRunStatus(
  api: ApiClient,
  pat: string,
  runId: string,
  timeoutMs = 45_000,
): Promise<{ status: string; autoApproved: boolean }> {
  const deadline = Date.now() + timeoutMs;
  // Give the diff-worker a moment to pick up the job before first read.
  await sleep(1_500);
  let last = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const run = await api.getRun(pat, runId);
    const s = run.status;
    if (!NON_TERMINAL.has(s)) {
      if (s === last) {
        // stable for two consecutive reads → accept
        if (stableSince && Date.now() - stableSince >= 1_200) {
          return { status: s, autoApproved: run.autoApproved ?? false };
        }
      } else {
        stableSince = Date.now();
      }
    }
    last = s;
    await sleep(1_200);
  }
  throw new Error(`run ${runId} did not settle within ${timeoutMs}ms (last=${last})`);
}

export async function capture(
  api: ApiClient,
  input: CaptureInput,
): Promise<CaptureResult> {
  const build = await api.createBuild(input.pat, input.projectId, {
    branchName: input.branchName,
    ...(input.buildName ? { name: input.buildName } : {}),
  });
  const run = await api.createRun(input.pat, {
    projectId: input.projectId,
    buildId: build.id,
    name: input.checkpointName,
    branchName: input.branchName,
    ...(input.parentBranchName
      ? { parentBranchName: input.parentBranchName }
      : {}),
  });
  await api.uploadScreenshotBase64(input.pat, run.runId, {
    pngBase64: pngBase64(input.fixture),
    name: input.checkpointName,
    viewport: input.viewport ?? "400x300",
    browser: input.browser ?? "chromium",
    ...(input.domHtml ? { domHtml: input.domHtml } : {}),
    ...(input.elementMapJson ? { elementMapJson: input.elementMapJson } : {}),
  });
  await api.completeRun(input.pat, run.runId);
  const settled = await pollRunStatus(api, input.pat, run.runId);
  return {
    buildId: build.id,
    runId: run.runId,
    status: settled.status,
    autoApproved: settled.autoApproved,
  };
}
