import {
  expect,
  firefox,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import sharp from "sharp";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import {
  captureRun,
  type CaptureRunResult,
} from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

type RGB = readonly [number, number, number];

/**
 * The screenshots' size. The stage card takes the image's aspect at the
 * stage's full width, and an image this wide is drawn below the 2× fit cap,
 * so it fills the card: a point at a fraction of the card is the same
 * fraction of the image.
 */
const W = 1200;
const H = 600;

/** The first step: the baseline is all A; the current is A, then B on its right half. */
const A: RGB = [37, 99, 235];
const B: RGB = [22, 163, 74];
/** The second step, there to step to and back from: baseline all C, current all D. */
const C: RGB = [120, 120, 120];
const D: RGB = [200, 60, 160];

/*
 * Over every single-stage mode the viewer draws the step's regions above the
 * images (`DiffOverlayLayer`). Outside Diff (Swipe, Flicker, Overlay) a
 * region is an outline along its box, with no fill, so the pixels inside it
 * are the image's own (R28). The first step's right half changed, so it is
 * one region along that half (checked in `beforeAll`): the right sample is
 * inside it, clear of its outline, and reads the image's colour exactly, as
 * the left one does.
 */

/**
 * Where the stage is sampled, as fractions of its box: 25% and 75% of its
 * width, at mid-height, clear of the canvas label (top left) and of Swipe's
 * handle (on the divider).
 */
const POINTS = {
  left: { x: 0.25, y: 0.5 },
  right: { x: 0.75, y: 0.5 },
} as const;
type Side = keyof typeof POINTS;

/** Per channel: the canvas's sampling and the PNG round trip, nothing more. */
const TOLERANCE = 3;

/** A W×H PNG whose column `x` is `colour(x)`. */
function png(colour: (x: number) => RGB): Promise<Buffer> {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) raw.set(colour(x), (y * W + x) * 3);
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * The colour at each side's point, read from a screenshot of the stage
 * decoded here. The canvas itself can't be read back from the page: pixi's
 * WebGL canvas doesn't keep its drawing buffer, so `toDataURL` reads blank.
 */
async function stageColours(
  page: Page,
  sides: readonly Side[],
): Promise<RGB[]> {
  const shot = await page.getByTestId("single-stage-host").screenshot();
  const { data, info } = await sharp(shot)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sides.map((side) => {
    const { x, y } = POINTS[side];
    const px = Math.min(info.width - 1, Math.floor(x * info.width));
    const py = Math.min(info.height - 1, Math.floor(y * info.height));
    const i = (py * info.width + px) * info.channels;
    return [data[i] ?? -1, data[i + 1] ?? -1, data[i + 2] ?? -1];
  });
}

const near = (got: RGB, want: RGB): boolean =>
  got.every((v, i) => Math.abs(v - (want[i] ?? -1)) <= TOLERANCE);

/**
 * Wait until the stage shows `want` at each side's point, within
 * `TOLERANCE`. A mode or a frame is drawn a frame or two after its key, so
 * this polls; on failure it shows the colours it last saw.
 */
async function expectStage(
  page: Page,
  want: Partial<Record<Side, RGB>>,
  what: string,
): Promise<void> {
  const sides = Object.keys(want) as Side[];
  await expect
    .poll(
      async () => {
        const got = await stageColours(page, sides);
        return Object.fromEntries(
          sides.map((side, i) => {
            const seen = got[i] ?? [-1, -1, -1];
            const expected = want[side];
            return [side, expected && near(seen, expected) ? expected : seen];
          }),
        );
      },
      { message: what, intervals: [100, 250, 500], timeout: 15_000 },
    )
    .toEqual(want);
}

/** The radio of the mode named `name` in the viewer's "Comparison mode" group. */
const modeRadio = (page: Page, name: string): Locator =>
  page
    .getByRole("radiogroup", { name: "Comparison mode" })
    .getByRole("radio", { name, exact: true });

/** Press `key` and wait for the mode it picks. */
async function pickMode(page: Page, key: string, name: string): Promise<void> {
  await page.keyboard.press(key);
  await expect(modeRadio(page, name)).toHaveAttribute("aria-checked", "true");
}

/**
 * Swipe and Flicker on the first step, the checks every engine runs:
 *
 * - Swipe at 50%: the baseline left of the divider (A at 25%), the current
 *   right of it (B at 75%). The slider's own keys: → twice is 54%, and End
 *   takes the divider to 100%, where the baseline shows all the way across
 *   (A at 75%).
 * - Flicker, still (motion is reduced): it opens on the baseline (A at 75%)
 *   and `f` swaps it to the current (B at 75%), the canvas label with it.
 */
async function checkSwipeAndFlicker(page: Page): Promise<void> {
  await pickMode(page, "2", "Swipe");
  const handle = page.getByRole("slider", { name: "Swipe position" });
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await expectStage(
    page,
    { left: A, right: B },
    "Swipe at 50%: the baseline left of the divider, the current right of it",
  );

  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "54");
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "100");
  await expectStage(
    page,
    { right: A },
    "Swipe at 100%: the baseline all the way across",
  );

  await pickMode(page, "3", "Flicker");
  const label = page.getByTestId("canvas-mode-label");
  // Reduced motion: no Play, and the flicker stands still on the baseline.
  await expect(page.getByTestId("flicker-play-toggle")).toHaveCount(0);
  await expect(label).toHaveText("Baseline");
  await expectStage(page, { right: A }, "Flicker, still, on the baseline");
  await page.keyboard.press("f");
  await expect(label).toHaveText("Current");
  await expectStage(
    page,
    { right: B },
    "Flicker after f, on the current image",
  );
}

/** Where the viewer fetches an image, by its storage key. */
const STORAGE = "/api/v1/storage/";

/** The storage key a request fetches, or null for any other request. */
function storageKey(req: Request): string | null {
  const { pathname } = new URL(req.url());
  const at = pathname.indexOf(STORAGE);
  return at < 0
    ? null
    : decodeURIComponent(pathname.slice(at + STORAGE.length));
}

/** How many times each key was requested. */
const countsOf = (keys: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
};

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

/** What a user's project assignment was, to put it back afterwards. */
interface Assignment {
  userId: string;
  projectIds: string[];
  defaultProjectId: string | null;
}

/** The parts of `runs.getStep` (one step, as the viewer reads it) this spec reads. */
interface StepView {
  step: { id: string; imageKey: string | null; diffImageKey: string | null };
  baselineContext: {
    baselineScreenshot: { imageKey: string | null } | null;
  };
  /** The step's regions, and the run's on no step (pre-v1.1.20). */
  regions: Array<{
    screenshotId: string | null;
    severity: string;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
}

/**
 * The diff viewer's comparison modes, checked on the pixels they draw and the
 * images they fetch, in a real browser, then Swipe and Flicker again in
 * WebKit and Firefox.
 *
 * It builds its OWN data in a project of its own, created fresh for every
 * run: one run of two steps on one branch, its baseline approved wholesale.
 *
 *   half : baseline all A,  current A with B on its right half
 *   next : baseline all C,  current all D
 *
 * Each step has a baseline, a current and a diff image, six in all, and all
 * different: storage keys are content hashes, so two equal images would
 * share one key and the request counts could not tell them apart. The
 * images are drawn here, with sharp, and uploaded as the SDK does
 * (`captureRun`): the two steps share a run, as → / ← step within a run and
 * the viewer fetches a step's neighbours ahead.
 *
 * Pixels are read from a screenshot of the stage, decoded with sharp. The
 * first step has one region, its changed right half, which every
 * single-stage mode draws over the images: outside Diff as an outline alone
 * (R28), so the samples inside it read the images' own colours.
 *
 * The flow makes the project the bootstrap admin's default for its run and
 * puts the old assignment back afterwards, as the other UI specs do. The
 * admin can sign in about 10 times in 15 minutes (ADR-063), so the flow
 * signs in ONCE, in Chromium, and WebKit and Firefox open with that session.
 *
 * Serial: the network checks build on the page the previous test left.
 */
test.describe.serial("ui: viewer comparison modes", () => {
  const api = new ApiClient(API);
  let context: BrowserContext;
  let page: Page;
  let session: Awaited<ReturnType<BrowserContext["storageState"]>>;
  let admin = ""; // the reviewer (dashboard principal)
  let pat = ""; // the SDK / CI principal
  let projectId = "";
  let restore: Assignment | undefined;
  let current: CaptureRunResult;
  /** Each step's three images: baseline, current and diff. */
  let images: Record<"half" | "next", string[]>;
  /** The storage key of every image request the Chromium page made, in order. */
  const fetched: string[] = [];

  /** A step's page in the diff viewer (its path; the URL may carry `?view`). */
  const stepPath = (name: "half" | "next"): string =>
    `/projects/${projectId}/runs/${current.runId}/checkpoints/${current.checkpointIds[name]}`;
  const atStep =
    (name: "half" | "next") =>
    (url: URL): boolean =>
      url.pathname === stepPath(name);

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // Two captures, each waiting on the diff pipeline, and a login.
    test.setTimeout(240_000);
    ({ admin, pat } = ownerCreds());

    // The admin's assignment as it is before this run touches anything:
    // creating a project may make its creator a member, which the restore
    // must not keep.
    const me = await api.me(admin);
    restore = {
      userId: me.id,
      projectIds: await api.listUserProjects(admin, me.id),
      defaultProjectId: me.defaultProjectId ?? null,
    };

    const stamp = Date.now();
    projectId = (
      await api.createProject(admin, { name: `viewer-compare-ui-${stamp}` })
    ).id;
    const branch = `viewer-compare-${stamp}`;
    const viewport = `${W}x${H}`;

    const baseline = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildName: "viewer-compare-baseline",
      viewport,
      checkpoints: [
        { name: "half", png: await png(() => A) },
        { name: "next", png: await png(() => C) },
      ],
    });
    expect(baseline.status).toBe("new");
    await api.approveRun(admin, baseline.runId);

    current = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildName: "viewer-compare-current",
      viewport,
      checkpoints: [
        { name: "half", png: await png((x) => (x < W / 2 ? A : B)) },
        { name: "next", png: await png(() => D) },
      ],
    });
    expect(current.status).toBe("unresolved");

    // Each step's images, as the viewer will ask for them: one step's read
    // at a time (spec 2026-10-27 §5).
    const stepOf = (name: "half" | "next"): Promise<StepView> =>
      api.trpcQuery<StepView>(admin, "runs.getStep", {
        runId: current.runId,
        checkpointId: current.checkpointIds[name],
      });
    const steps = { half: await stepOf("half"), next: await stepOf("next") };
    const keysOf = (name: "half" | "next"): string[] => {
      const { step, baselineContext } = steps[name];
      const keys = [
        baselineContext.baselineScreenshot?.imageKey,
        step.imageKey,
        step.diffImageKey,
      ];
      if (!keys.every((k): k is string => typeof k === "string")) {
        throw new Error(
          `step ${name} lacks an image key: ${JSON.stringify(keys)}`,
        );
      }
      return keys;
    };
    images = { half: keysOf("half"), next: keysOf("next") };
    expect(
      new Set([...images.half, ...images.next]).size,
      "six different images",
    ).toBe(6);

    // What the colour checks rely on: the first step's one region is its
    // right half, around the right sample point and not the left, so its
    // outline (R28) runs clear of both.
    const regions = steps.half.regions.filter(
      (r) => r.screenshotId === current.checkpointIds.half,
    );
    expect(regions.map((r) => r.severity)).toEqual(["major"]);
    const [box] = regions.map((r) => r.bbox);
    const covers = (side: Side): boolean => {
      const x = POINTS[side].x * W;
      const y = POINTS[side].y * H;
      return (
        box !== undefined &&
        x >= box.x &&
        x < box.x + box.width &&
        y >= box.y &&
        y < box.y + box.height
      );
    };
    expect({ left: covers("left"), right: covers("right") }).toEqual({
      left: false,
      right: true,
    });

    // Make the project the reviewer's current one, keeping every membership
    // the admin already had.
    await api.setUserProjects(admin, {
      userId: me.id,
      projectIds: [...new Set([...restore.projectIds, projectId])],
      defaultProjectId: projectId,
    });

    // One session for the whole flow. Reduced motion: Flicker stands still
    // until `f` swaps it.
    context = await browser.newContext({
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await context.addInitScript({ content: NO_TOURS });
    page = await context.newPage();
    await page.goto("/login");
    await page.fill("#email", BOOTSTRAP_EMAIL);
    await page.fill("#password", BOOTSTRAP_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 20_000,
    });
    // The session as it is now, before the viewer stores any preference:
    // WebKit and Firefox start from it.
    session = await context.storageState();
    page.on("request", (req) => {
      const key = storageKey(req);
      if (key !== null) fetched.push(key);
    });
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

  test("First view fetches each image once; Swipe, Flicker and Overlay draw the right pixels; changing modes fetches nothing", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.viewer_compare"]));

    await page.goto(stepPath("half"));
    await expect(modeRadio(page, "Side by side")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // The step's three images, then the next step's three (fetched ahead
    // once this step's are in), each requested once.
    const once = Object.fromEntries(
      [...images.half, ...images.next].map((key) => [key, 1]),
    );
    await expect
      .poll(() => countsOf(fetched), {
        message: "the image requests of the first view",
        intervals: [250, 500, 1_000],
        timeout: 30_000,
      })
      .toEqual(once);

    await checkSwipeAndFlicker(page);

    // Overlay at 100%: the current image on top of the baseline.
    await pickMode(page, "4", "Overlay");
    await expect(page.getByTestId("canvas-mode-label")).toHaveText(
      "Current over baseline",
    );
    const opacity = page.getByRole("slider", { name: "Overlay opacity" });
    await opacity.focus();
    await page.keyboard.press("End");
    await expect(opacity).toHaveAttribute("aria-valuenow", "100");
    await expectStage(
      page,
      { right: B },
      "Overlay at 100%: the current image over the baseline",
    );

    await pickMode(page, "5", "Diff");
    await expect(page.getByTestId("canvas-mode-label")).toHaveText("Current");
    await pickMode(page, "1", "Side by side");

    // Five modes, and not one more request.
    expect(countsOf(fetched), "image requests after all five modes").toEqual(
      once,
    );
  });

  test("→ goes to the next step and ← comes back, fetching nothing; the step's images still draw", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.viewer_compare"]));

    const before = countsOf(fetched);
    // The keys go to the page, not to a control that takes arrows.
    await page.evaluate(
      "document.activeElement instanceof HTMLElement && document.activeElement.blur()",
    );

    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(atStep("next"));
    await expect(page.getByTestId("test-info-sidebar")).toContainText(
      "2/2 next",
    );
    await expect(page.getByTestId("candidate-canvas-host")).not.toHaveAttribute(
      "aria-busy",
      "true",
    );

    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(atStep("half"));
    await expect(page.getByTestId("test-info-sidebar")).toContainText(
      "1/2 half",
    );

    // Its bitmaps are still there to draw (none was closed on the way): both
    // sides of Swipe show their image.
    await pickMode(page, "2", "Swipe");
    await expectStage(
      page,
      { left: A, right: B },
      "Swipe at 50% after stepping back",
    );

    const after = countsOf(fetched);
    expect(
      images.half.map((key) => after[key]),
      "requests for the first step's images, after the step there and back",
    ).toEqual([1, 1, 1]);
    // And none at all: the next step's images came with the first view.
    expect(after, "image requests after the step there and back").toEqual(
      before,
    );
  });

  for (const engine of [webkit, firefox]) {
    test(`${engine.name()}: Swipe and Flicker draw the right pixels, and the slider's keys move the divider`, async ({}, testInfo) => {
      testInfo.annotations.push(...coverAnnotations(["review.viewer_compare"]));
      // Room to start a browser of another engine, on top of the checks.
      test.setTimeout(180_000);

      const { baseURL } = test.info().project.use;
      const other = await engine.launch();
      try {
        const ctx = await other.newContext({
          ...(baseURL ? { baseURL } : {}),
          colorScheme: "light",
          reducedMotion: "reduce",
          storageState: session,
        });
        await ctx.addInitScript({ content: NO_TOURS });
        const p = await ctx.newPage();
        await p.goto(stepPath("half"));
        await expect(p).toHaveURL(atStep("half"));
        await expect(modeRadio(p, "Side by side")).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await checkSwipeAndFlicker(p);
      } finally {
        await other.close();
      }
    });
  }
});
