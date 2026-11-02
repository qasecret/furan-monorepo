import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import {
  captureRun,
  type CaptureRunResult,
} from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

/** The parts of `runs.getStep` (one step, as the viewer reads it) this spec reads. */
interface StepView {
  step: {
    id: string;
    diffPercent: number | null;
    imageKey: string | null;
    diffImageKey: string | null;
  };
  baselineContext: { baselineScreenshot: { imageKey: string | null } | null };
}

/** One procedure call of a tRPC request the page sent, with its input. */
interface Call {
  path: string;
  input: unknown;
}

/** What a user's project assignment was, to put it back afterwards. */
interface Assignment {
  userId: string;
  projectIds: string[];
  defaultProjectId: string | null;
}

const TRPC = "/trpc/";
const STORAGE = "/api/v1/storage/";

/**
 * The procedure calls of a tRPC request: a batched GET names its paths in
 * the URL, comma-separated, and sends their inputs as one JSON object keyed
 * by position. A POST (a mutation) carries its inputs in the body: its calls
 * have none here. The api may sit behind `/api` (the single origin) or on an
 * origin of its own (a dev stack): only the path after `/trpc/` counts.
 */
function callsOf(url: string): Call[] {
  const { pathname, searchParams } = new URL(url);
  const at = pathname.indexOf(TRPC);
  if (at < 0) return [];
  const paths = decodeURIComponent(pathname.slice(at + TRPC.length))
    .split(",")
    .filter((p) => p !== "");
  let inputs: Record<string, unknown> = {};
  const raw = searchParams.get("input");
  if (raw !== null) {
    const parsed = JSON.parse(raw) as unknown;
    inputs =
      searchParams.get("batch") === "1"
        ? (parsed as Record<string, unknown>)
        : { "0": parsed };
  }
  return paths.map((path, i) => ({ path, input: inputs[String(i)] }));
}

/** The storage key an image request fetches, or null for any other request. */
function storageKey(req: Request): string | null {
  const { pathname } = new URL(req.url());
  const at = pathname.indexOf(STORAGE);
  return at < 0
    ? null
    : decodeURIComponent(pathname.slice(at + STORAGE.length));
}

/**
 * First-visit page tours (components/tour) open over the page behind a scrim
 * that takes the keys until dismissed; dismissal lives in localStorage per
 * page (`furan:tour:dismissed:<pageId>`). Report every tour as already
 * dismissed, as the other UI specs do.
 */
const NO_TOURS = `(() => {
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    return typeof key === "string" && key.startsWith("furan:tour:dismissed:")
      ? "1"
      : getItem.call(this, key);
  };
})();`;

/**
 * The diff viewer reads one step at a time (spec 2026-10-27 §5): opening a
 * step asks `runs.getStep` for it, and for the steps either side of it in
 * the rail ahead of a move; the run header is `runs.getById`, and the batch
 * (`builds.getById`) is not asked for at all. The step on screen is drawn
 * with its own diff: its pixel diff and its diff image.
 *
 * It builds its OWN data in a project of its own, created fresh for every
 * run: one run of three steps on one branch, its baseline approved
 * wholesale, then a second capture whose middle step changed.
 *
 *   first  : unchanged
 *   middle : changed (the step opened)
 *   last   : unchanged
 *
 * Opening the middle step makes both neighbours exist. The flow makes the
 * project the bootstrap admin's default for its run and puts the old
 * assignment back afterwards, as the other UI specs do, and signs in once
 * (ADR-063's login brake).
 */
test.describe.serial("review: the viewer reads one step", () => {
  const api = new ApiClient(API);
  let context: BrowserContext;
  let page: Page;
  let admin = ""; // the reviewer (dashboard principal)
  let pat = ""; // the SDK / CI principal
  let projectId = "";
  let restore: Assignment | undefined;
  let current: CaptureRunResult;
  /** The middle step as the api reads it for the viewer. */
  let middle: StepView;
  /** Every tRPC call the page sent, in order. */
  const calls: Call[] = [];
  /** Every getStep answer the page received, by its step id. */
  const answered = new Map<string, StepView>();
  /** The storage key of every image request the page made. */
  const fetched: string[] = [];

  const ids = (): Record<"first" | "middle" | "last", string> => ({
    first: current.checkpointIds.first!,
    middle: current.checkpointIds.middle!,
    last: current.checkpointIds.last!,
  });

  /** The steps the page asked `runs.getStep` for, as `runId/checkpointId`. */
  const stepReads = (): string[] =>
    calls
      .filter((c) => c.path === "runs.getStep")
      .map((c) => {
        const input = c.input as { runId?: string; checkpointId?: string };
        return `${input.runId}/${input.checkpointId}`;
      });

  /** Whether the page asked for the batch (`builds.getById`). */
  const calledBatch = (): boolean =>
    calls.some((c) => c.path === "builds.getById");

  /** Keeps every getStep answer of a batched GET, by the step it names. */
  async function keepSteps(res: Response): Promise<void> {
    const sent = callsOf(res.url());
    if (!sent.some((c) => c.path === "runs.getStep") || !res.ok()) return;
    const body = (await res.json().catch(() => null)) as unknown;
    const results = Array.isArray(body) ? body : [body];
    sent.forEach((call, i) => {
      if (call.path !== "runs.getStep") return;
      const data = (results[i] as { result?: { data?: StepView } } | undefined)
        ?.result?.data;
      if (data?.step?.id !== undefined) answered.set(data.step.id, data);
    });
  }

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // Two captures, each waiting on the diff pipeline, and a login.
    test.setTimeout(240_000);
    ({ admin, pat } = ownerCreds());

    // The admin's assignment as it is before this run touches anything.
    const me = await api.me(admin);
    restore = {
      userId: me.id,
      projectIds: await api.listUserProjects(admin, me.id),
      defaultProjectId: me.defaultProjectId ?? null,
    };

    const stamp = Date.now();
    projectId = (
      await api.createProject(admin, { name: `viewer-step-ui-${stamp}` })
    ).id;
    const branch = `viewer-step-${stamp}`;

    const baseline = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildName: "viewer-step-baseline",
      checkpoints: [
        { name: "first", fixture: "baseline" },
        { name: "middle", fixture: "baseline" },
        { name: "last", fixture: "baseline" },
      ],
    });
    expect(baseline.status).toBe("new");
    await api.approveRun(admin, baseline.runId);

    current = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildName: "viewer-step-current",
      checkpoints: [
        { name: "first", fixture: "baseline" },
        { name: "middle", fixture: "changed" },
        { name: "last", fixture: "baseline" },
      ],
    });
    expect(current.status).toBe("unresolved");

    // What the page must show for the middle step: its own diff.
    middle = await api.trpcQuery<StepView>(admin, "runs.getStep", {
      runId: current.runId,
      checkpointId: ids().middle,
    });
    expect(
      middle.step.diffPercent ?? 0,
      "the middle step changed",
    ).toBeGreaterThan(0);
    expect(
      middle.step.diffImageKey,
      "the middle step has a diff image",
    ).not.toBeNull();

    // Make the project the reviewer's current one, keeping every membership
    // the admin already had.
    await api.setUserProjects(admin, {
      userId: me.id,
      projectIds: [...new Set([...restore.projectIds, projectId])],
      defaultProjectId: projectId,
    });

    context = await browser.newContext({ colorScheme: "light" });
    await context.addInitScript({ content: NO_TOURS });
    page = await context.newPage();
    await page.goto("/login");
    await page.fill("#email", BOOTSTRAP_EMAIL);
    await page.fill("#password", BOOTSTRAP_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 20_000,
    });
    // Only the viewer's calls from here on.
    page.on("request", (req) => {
      calls.push(...callsOf(req.url()));
      const key = storageKey(req);
      if (key !== null) fetched.push(key);
    });
    page.on("response", (res) => void keepSteps(res));
  });

  test.afterAll(async () => {
    // Put the admin's projects and default back as they were, first: a
    // context that fails to close must not leave them changed.
    try {
      if (restore) await api.setUserProjects(admin, restore);
    } finally {
      await context?.close();
    }
  });

  test("opening a step loads it through getStep and shows its diff", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.viewer_step"]));
    const { first, last } = ids();
    const step = ids().middle;
    const run = current.runId;

    await page.goto(`/projects/${projectId}/runs/${run}/checkpoints/${step}`);
    // The stage names the step once its images are drawn.
    await expect(page.locator(`[data-stage-drawn="${step}"]`)).toBeAttached({
      timeout: 30_000,
    });

    // The step on screen, read on its own, then both neighbours fetched
    // ahead: each once, and no other step.
    await expect
      .poll(() => [...stepReads()].sort(), {
        message: "the steps the viewer read through runs.getStep",
        intervals: [250, 500, 1_000],
        timeout: 15_000,
      })
      .toEqual([`${run}/${first}`, `${run}/${step}`, `${run}/${last}`].sort());
    expect(stepReads()[0], "the step on screen is read first").toBe(
      `${run}/${step}`,
    );
    // ...and the page received the step it asked for.
    expect(answered.get(step)?.step.id).toBe(step);

    // The run header is runs.getById; the batch is never asked for.
    expect(
      calls.filter((c) => c.path === "runs.getById").map((c) => c.input),
    ).toContainEqual({ runId: run });
    expect(calledBatch(), "builds.getById was called").toBe(false);

    // Its own diff: its pixel diff in the sidebar, and its diff image on the
    // stage, beside its baseline and its current image.
    await expect(page.getByTestId("info-stat-cards")).toContainText(
      `${middle.step.diffPercent!.toFixed(2)}%`,
    );
    await expect
      .poll(() => fetched, {
        message: "the step's images the viewer fetched",
        timeout: 15_000,
      })
      .toEqual(
        expect.arrayContaining(
          [
            middle.baselineContext.baselineScreenshot?.imageKey,
            middle.step.imageKey,
            middle.step.diffImageKey,
          ].filter((k): k is string => typeof k === "string"),
        ),
      );
    // Nor once the page has settled: no batch, and still the step and its
    // two neighbours, each read once, and no other step.
    expect(calledBatch(), "builds.getById was called").toBe(false);
    expect(
      [...stepReads()].sort(),
      "the steps read through runs.getStep once the page settled",
    ).toEqual([`${run}/${first}`, `${run}/${step}`, `${run}/${last}`].sort());
  });
});
