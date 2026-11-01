import {
  Furan,
  pngSize,
  type Box,
  type FuranBuild,
  type FuranOptions,
  type FuranTest,
  type MatchLevel,
} from "@furan/client";
import {
  test as base,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { toImageRegion, type CaptureMode } from "./regions.js";

/** Set with `use: { furanOptions: { … } }` in the config or `test.use`. */
export interface FuranPlaywrightOptions {
  /** Fail the test when a step has no baseline yet (default: pass with a warning). */
  failOnNew?: boolean;
  /** Approve first baselines automatically. */
  saveNewTests?: boolean;
  /** Default `fullPage` for every check. */
  fullPage?: boolean;
  /** Verdict wait budget per test, in ms (default 120 s). */
  timeoutMs?: number;
  os?: string;
  device?: string;
  /** Explicit connection settings, instead of the `FURAN_*` env. */
  config?: FuranOptions;
}

/** A locator (every element it matches) or a box in screenshot pixels. */
export type Area = Locator | Box;

export interface FuranCheckOptions {
  fullPage?: boolean;
  /** Screenshot just this element. */
  locator?: Locator;
  ignore?: Area[];
  layout?: Area[];
  content?: Area[];
  matchLevel?: MatchLevel;
}

export interface FuranFixture {
  /** Screenshot the page (or `locator`) and upload it as a step of this test. */
  check(name: string, options?: FuranCheckOptions): Promise<void>;
}

interface TestFixtures {
  furan: FuranFixture;
}

interface WorkerFixtures {
  furanOptions: FuranPlaywrightOptions;
  /** This worker's Furan instance (config + client). */
  furanClient: Furan;
  /** The build every test of this worker goes into. */
  furanBuild: FuranBuild;
}

let hinted = false;

const isLocator = (a: Area): a is Locator =>
  typeof (a as Locator).boundingBox === "function";

const SHOT = { animations: "disabled", caret: "hide", scale: "css" } as const;

export const test = base.extend<TestFixtures, WorkerFixtures>({
  furanOptions: [{}, { option: true, scope: "worker" }],

  furanClient: [
    async ({ furanOptions: o }, use) => {
      await use(
        Furan.fromEnv({
          ...o.config,
          saveNewTests: o.saveNewTests,
          failOnNew: o.failOnNew,
          timeoutMs: o.timeoutMs,
          os: o.os,
          device: o.device,
        }),
      );
    },
    { scope: "worker" },
  ],

  furanBuild: [
    async ({ furanClient }, use) => {
      const { ciBuildId, buildId } = furanClient.config;
      if (ciBuildId === null && buildId === null && !hinted) {
        hinted = true;
        console.warn(
          'furan: no FURAN_CI_BUILD_ID, so each Playwright worker makes its own build; add globalSetup: "@furan/playwright/global-setup" to put a local run in one build',
        );
      }
      await use(await furanClient.openBuild());
    },
    { scope: "worker" },
  ],

  furan: async (
    { page, browserName, furanBuild, furanClient, furanOptions },
    use,
    testInfo,
  ) => {
    const title = testInfo.titlePath.join(" › ");
    let opening: Promise<FuranTest> | null = null;

    await use({
      check: async (name, options = {}) => {
        opening ??= furanBuild.openTest(title);
        const furanTest = await opening;
        const shot = await capture(page, options, furanOptions);
        const image = pngSize(shot.png);
        const boxes = async (areas: Area[] = []): Promise<Box[]> => {
          const out: Box[] = [];
          for (const area of areas) {
            if (!isLocator(area)) {
              out.push(area);
              continue;
            }
            for (const element of await area.all()) {
              const box = await element.boundingBox();
              const region = box && toImageRegion(box, shot.mode, image);
              if (region) out.push(region);
            }
          }
          return out;
        };
        const viewport = page.viewportSize();
        await furanTest.check(`${title} › ${name}`, shot.png, {
          ignore: await boxes(options.ignore),
          layout: await boxes(options.layout),
          content: await boxes(options.content),
          ...(options.matchLevel ? { matchLevel: options.matchLevel } : {}),
          ...(viewport
            ? { viewport: `${viewport.width}x${viewport.height}` }
            : {}),
          browser: furanClient.config.browser ?? `playwright-${browserName}`,
        });
      },
    });

    if (opening === null) return;
    const furanTest = await opening;
    await settle(furanTest, furanClient, testInfo, title);
  },
});

async function capture(
  page: Page,
  options: FuranCheckOptions,
  defaults: FuranPlaywrightOptions,
): Promise<{ png: Uint8Array; mode: CaptureMode }> {
  if (options.locator) {
    const box = await options.locator.boundingBox();
    if (!box) {
      throw new Error("furan.check: the locator to screenshot is not visible");
    }
    return {
      png: new Uint8Array(await options.locator.screenshot(SHOT)),
      mode: { kind: "element", box },
    };
  }
  const fullPage = options.fullPage ?? defaults.fullPage ?? false;
  const png = new Uint8Array(await page.screenshot({ ...SHOT, fullPage }));
  if (!fullPage) return { png, mode: { kind: "viewport" } };
  const [scrollX, scrollY] = (await page.evaluate(
    "[window.scrollX, window.scrollY]",
  )) as [number, number];
  return { png, mode: { kind: "fullPage", scrollX, scrollY } };
}

/** Complete the Furan test and turn its verdict into the Playwright outcome. */
async function settle(
  furanTest: FuranTest,
  furan: Furan,
  testInfo: TestInfo,
  title: string,
): Promise<void> {
  const where = furanTest.url ?? `run ${furanTest.runId}`;
  testInfo.annotations.push({ type: "furan", description: where });
  if (testInfo.status !== testInfo.expectedStatus) {
    // The test already failed: keep its steps reviewable, don't wait.
    await furanTest.complete();
    return;
  }
  testInfo.setTimeout(testInfo.timeout + furan.config.timeoutMs);
  const result = await furanTest.close();
  const steps = result.steps.map((s) => s.slice(title.length + 3)).join(", ");
  switch (result.status) {
    case "failed":
      throw new Error(
        `furan: "${title}" needs review (${steps}; ${result.serverStatus ?? "failed"}): ${where}`,
      );
    case "new":
      if (furan.config.failOnNew) {
        throw new Error(
          `furan: "${title}" has no baseline yet (${steps}); approve it in the dashboard: ${where}`,
        );
      }
      console.warn(
        `furan: "${title}" has no baseline yet (${steps}); approve it in the dashboard: ${where}`,
      );
      return;
    case "error":
      throw new Error(
        `furan: no verdict for "${title}": ${result.error?.message ?? "unknown error"}`,
        { cause: result.error },
      );
    default:
      return;
  }
}
