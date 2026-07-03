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

function pngBuffer(fixture: Fixture): Buffer {
  return readFileSync(`${FIX_DIR}${fixture}.png`);
}
function pngBase64(fixture: Fixture): string {
  return pngBuffer(fixture).toString("base64");
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
  /** Set any of these → upload via the multipart endpoint (base64 omits them). */
  matchLevel?: "Strict" | "Layout" | "Content" | "IgnoreColors" | "Dynamic";
  accessibilityLevel?: "AA" | "AAA";
  accessibilityVersion?: "WCAG_2_0" | "WCAG_2_1";
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
 * Poll `GET /runs/:id` until the diff-worker settles the run's status, or until
 * `timeoutMs`.
 *
 * The FIRST non-in-progress status read IS the verdict — no stability heuristic
 * needed — because the server no longer emits a premature rollup: `/complete`
 * on a run with checkpoints leaves `status` as `running` and lets the diff
 * pipeline own the terminal value (new/passed/unresolved/aborted/failed). See
 * apps/api/src/routes/runs-lifecycle.ts (the `>=1 checkpoint` branch). So we
 * simply wait out the in-progress states and return the first terminal one.
 */
export async function pollRunStatus(
  api: ApiClient,
  pat: string,
  runId: string,
  timeoutMs = 45_000,
): Promise<{ status: string; autoApproved: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const run = await api.getRun(pat, runId);
    last = run.status;
    if (!NON_TERMINAL.has(last)) {
      return { status: last, autoApproved: run.autoApproved ?? false };
    }
    await sleep(1_000);
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
  const viewport = input.viewport ?? "400x300";
  const browser = input.browser ?? "chromium";
  // matchLevel + the axe a11y opts only exist on the multipart endpoint, so
  // route through it when any is set; otherwise the simpler base64 variant.
  if (input.matchLevel || input.accessibilityLevel) {
    await api.uploadScreenshotMultipart(input.pat, run.runId, {
      png: pngBuffer(input.fixture),
      name: input.checkpointName,
      viewport,
      browser,
      ...(input.matchLevel ? { matchLevel: input.matchLevel } : {}),
      ...(input.domHtml ? { domHtml: input.domHtml } : {}),
      ...(input.elementMapJson ? { elementMapJson: input.elementMapJson } : {}),
      ...(input.accessibilityLevel
        ? { accessibilityLevel: input.accessibilityLevel }
        : {}),
      ...(input.accessibilityVersion
        ? { accessibilityVersion: input.accessibilityVersion }
        : {}),
    });
  } else {
    await api.uploadScreenshotBase64(input.pat, run.runId, {
      pngBase64: pngBase64(input.fixture),
      name: input.checkpointName,
      viewport,
      browser,
      ...(input.domHtml ? { domHtml: input.domHtml } : {}),
      ...(input.elementMapJson ? { elementMapJson: input.elementMapJson } : {}),
    });
  }
  await api.completeRun(input.pat, run.runId);
  const settled = await pollRunStatus(api, input.pat, run.runId);
  return {
    buildId: build.id,
    runId: run.runId,
    status: settled.status,
    autoApproved: settled.autoApproved,
  };
}
