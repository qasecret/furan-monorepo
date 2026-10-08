import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import { API_URL as API } from "../../src/env.js";
import {
  ensureVisualFixture,
  type VisualFixture,
} from "../../src/visual/fixture.js";
import { timeMasks } from "../../src/visual/masks.js";
import { DISCOVERED, staticRoutes } from "../../src/visual/routes.js";
import { uploadShots } from "../../src/visual/upload.js";

/**
 * Visual sweep (design-foundation spec §7.1): every dashboard route, in light
 * and dark, as a full-page 1440×900 screenshot plus an axe `color-contrast`
 * pass. Run once on `main` (`VISUAL_LABEL=before-…`) and once on the branch
 * (`VISUAL_LABEL=after-…`) and compare the two PNG sets — see e2e/README.md.
 *
 * Not part of `s3-full`: tagged `@visual`, run with `--project=visual`.
 */

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const LABEL = process.env.VISUAL_LABEL ?? "local";
const OUT_ROOT = process.env.VISUAL_OUT
  ? resolve(process.env.VISUAL_OUT)
  : fileURLToPath(new URL("../../visual-out/", import.meta.url));
const OUT = join(OUT_ROOT, LABEL);
const VIEWPORT = { width: 1440, height: 900 };

/** Pages a signed-in user can't see: `/` redirects a session to /home, so
 *  these are captured from a signed-out context. */
const PUBLIC_PATHS = new Set(["/", "/login"]);

/** Route names don't depend on the fixture, so tests can be declared up front;
 *  each test resolves its path once `beforeAll` has built the fixture. */
const STATIC_NAMES = staticRoutes({
  projectId: "",
  buildId: "",
  unresolvedRunId: "",
}).map((r) => r.name);

/**
 * The dashboard's live-update channels (SSE: /api/v1/events,
 * /api/v1/projects/:id/events, /api/v1/runs/:id/events). Their responses never
 * finish, so `networkidle` would never fire on a page that subscribes. The
 * sweep answers them with a 204, which tells EventSource to stop for good (no
 * reconnect); that only freezes live updates, which a screenshot doesn't need.
 */
const SSE = /\/api\/v1\/(?:[^?]*\/)?events(?:\?|$)/;

/**
 * First-visit page tours (components/tour) open over the page, behind a scrim
 * that would also skew the contrast check, until dismissed; dismissal lives in
 * localStorage per page (`furan:tour:dismissed:<pageId>`). Report every tour as
 * already dismissed, including ones added after this was written.
 */
const NO_TOURS = `(() => {
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    return typeof key === "string" && key.startsWith("furan:tour:dismissed:")
      ? "1"
      : getItem.call(this, key);
  };
})();`;

/** Next's dev-mode indicator (a dev-server stack only): hidden in shots,
 *  skipped by axe. */
const DEV_OVERLAY = "nextjs-portal";

/** Make every page in `ctx` render its steady state: no SSE, no tours. */
async function steady(ctx: BrowserContext): Promise<void> {
  await ctx.route(SSE, (route) =>
    route.fulfill({
      status: 204,
      headers: {
        "access-control-allow-origin":
          route.request().headers()["origin"] ?? "*",
        "access-control-allow-credentials": "true",
      },
    }),
  );
  await ctx.addInitScript({ content: NO_TOURS });
}

interface Contrast {
  theme: Theme;
  route: string;
  /** Where the route actually landed (after redirects). */
  url: string;
  nodes: number;
  examples: string[];
}

test.describe.serial("visual sweep @visual", () => {
  // A dashboard dev server compiles a route on first visit and again after it
  // has idled out, which on a busy machine can take minutes (seen: 2m for
  // /analytics); one slow compile must not sink the whole serial sweep.
  test.describe.configure({ timeout: 300_000 });

  const api = new ApiClient(API);
  let fixture: VisualFixture;
  let context: BrowserContext;
  let anon: BrowserContext;
  let page: Page;
  let anonPage: Page;
  const shots: { name: string; png: Buffer }[] = [];
  const contrast: Contrast[] = [];

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    fixture = await ensureVisualFixture(api);

    context = await browser.newContext({ viewport: VIEWPORT });
    await steady(context);
    page = await context.newPage();
    await page.goto("/login");
    await page.fill("#email", BOOTSTRAP_EMAIL);
    await page.fill("#password", BOOTSTRAP_PASSWORD);
    await page.click('button[type="submit"]');
    // Generous: a dashboard dev server may compile the login action first.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 60_000,
    });

    anon = await browser.newContext({ viewport: VIEWPORT });
    await steady(anon);
    anonPage = await anon.newPage();
  });

  test.afterAll(async () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "color-contrast.json"),
      JSON.stringify(contrast, null, 2),
    );
    const { FURAN_VISUAL_URL, FURAN_VISUAL_PAT, FURAN_VISUAL_PROJECT_ID } =
      process.env;
    if (FURAN_VISUAL_URL && FURAN_VISUAL_PAT && FURAN_VISUAL_PROJECT_ID) {
      const { buildId } = await uploadShots({
        apiUrl: FURAN_VISUAL_URL,
        pat: FURAN_VISUAL_PAT,
        projectId: FURAN_VISUAL_PROJECT_ID,
        branch: LABEL,
        buildName: `sweep-${LABEL}`,
        shots,
      });
      console.log(`[visual] uploaded ${shots.length} shots → build ${buildId}`);
    }
    await context?.close();
    await anon?.close();
  });

  /**
   * Wait until the page is done: the URL has stopped changing, the network is
   * idle, no "Loading…" placeholder is showing, and webfonts are in. The URL
   * check matters because a server `redirect()` inside the (protected)
   * Suspense boundary (e.g. /runs/:id → /checkpoints/_first) arrives as a
   * navigation AFTER the first document loads, and the diff viewer then
   * `router.replace`s the URL again.
   *
   * That late redirect navigation occasionally stalls on a dev server; if the
   * page doesn't settle, load the URL it reached directly, once.
   */
  async function settle(p: Page): Promise<void> {
    try {
      await settleOnce(p);
    } catch {
      await p.goto(p.url());
      await settleOnce(p);
    }
  }

  async function settleOnce(p: Page): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const url = p.url();
      await p.waitForLoadState("networkidle");
      await p.waitForTimeout(750);
      if (p.url() === url) break;
    }
    await expect(
      p.getByText(/^Loading\b.*…$/).filter({ visible: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    await p.waitForLoadState("networkidle");
    // A string: the e2e tsconfig has no DOM lib.
    await p.evaluate("document.fonts.ready.then(() => true)");
  }

  /** The first `a[href]` whose pathname matches; fails if none renders. */
  async function firstLink(p: Page, pattern: RegExp): Promise<string> {
    let href: string | undefined;
    await expect
      .poll(
        async () => {
          const hrefs = await p
            .locator("a[href]")
            .evaluateAll((els) => els.map((a) => a.getAttribute("href") ?? ""))
            .catch(() => [] as string[]); // a navigation raced the read
          href = hrefs.find((h) => pattern.test(new URL(h, p.url()).pathname));
          return href;
        },
        { message: `no a[href] matching ${pattern} on ${p.url()}` },
      )
      .toBeTruthy();
    return href!;
  }

  /**
   * Full-page screenshot once two consecutive shots 500ms apart are identical
   * (as `toHaveScreenshot` does): client-only work the network can't signal —
   * the diff canvas decoding and painting its images, a client redirect
   * rendering its target — would otherwise be caught half-done. Gives up after
   * ~10s and keeps the last shot.
   */
  async function stableScreenshot(p: Page): Promise<Buffer> {
    const shot = (): Promise<Buffer> =>
      p.screenshot({
        fullPage: true,
        animations: "disabled",
        mask: timeMasks(p),
        style: `${DEV_OVERLAY} { display: none !important; }`,
      });
    let prev = await shot();
    for (let i = 0; i < 20; i++) {
      await p.waitForTimeout(500);
      const next = await shot();
      if (next.equals(prev)) return next;
      prev = next;
    }
    return prev;
  }

  /** Settle, then screenshot, save, and run axe colour-contrast. */
  async function shoot(
    p: Page,
    theme: Theme,
    name: string,
    enforceContrast: boolean,
    testInfo: TestInfo,
  ): Promise<void> {
    // Park the pointer in a corner: wherever an earlier click left it, it
    // would otherwise hover (and highlight) whatever this page puts there.
    await p.mouse.move(VIEWPORT.width - 1, VIEWPORT.height - 1);
    await settle(p);
    const png = await stableScreenshot(p);
    const file = join(OUT, theme, `${name}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    shots.push({ name: `${theme}/${name}`, png });

    const { violations } = await new AxeBuilder({ page: p })
      .withRules(["color-contrast"])
      .exclude(DEV_OVERLAY)
      .analyze();
    const nodes = violations.flatMap((v) => v.nodes);
    const examples = nodes.slice(0, 5).map((n) => {
      const d = (n.any[0]?.data ?? {}) as {
        fgColor?: string;
        bgColor?: string;
        contrastRatio?: number;
        expectedContrastRatio?: string;
      };
      return `${d.fgColor ?? "?"} on ${d.bgColor ?? "?"} = ${d.contrastRatio ?? "?"}:1 (needs ${d.expectedContrastRatio ?? "?"}) at ${n.target.join(" ")}`;
    });
    contrast.push({
      theme,
      route: name,
      url: new URL(p.url()).pathname,
      nodes: nodes.length,
      examples,
    });
    if (enforceContrast) {
      expect(violations).toEqual([]);
    } else {
      testInfo.annotations.push({
        type: "color-contrast",
        description: `${nodes.length} node(s)${examples.length ? ` — ${examples.join("; ")}` : ""}`,
      });
    }
  }

  for (const theme of THEMES) {
    test.describe(theme, () => {
      const disposers: { dispose(): Promise<void> }[] = [];

      // Every document in both contexts starts with this theme stored, exactly
      // as if the user had picked it in the toggle. Disposed after the theme so
      // the next theme's script is the only one (init-script order is undefined).
      test.beforeAll(async () => {
        const content = `try { localStorage.setItem("furan-theme", ${JSON.stringify(theme)}); } catch {}`;
        disposers.push(
          await context.addInitScript({ content }),
          await anon.addInitScript({ content }),
        );
      });
      test.afterAll(async () => {
        await Promise.all(disposers.splice(0).map((d) => d.dispose()));
      });

      for (const name of STATIC_NAMES) {
        test(name, async ({}, testInfo) => {
          const route = staticRoutes(fixture).find((r) => r.name === name)!;
          const p = PUBLIC_PATHS.has(route.path) ? anonPage : page;
          await p.goto(route.path);
          await shoot(p, theme, route.name, route.enforceContrast, testInfo);
        });
      }

      for (const d of DISCOVERED) {
        test(d.name, async ({}, testInfo) => {
          await page.goto(d.from(fixture));
          for (const hop of [...(d.via ?? []), d.href]) {
            await settle(page);
            await page.goto(await firstLink(page, hop));
          }
          await shoot(page, theme, d.name, d.enforceContrast, testInfo);
        });
      }

      test("state-cmdk", async ({}, testInfo) => {
        await page.goto("/inbox");
        await settle(page);
        // ⌘K on macOS, Ctrl+K elsewhere. Lower-case: the palette matches
        // `e.key === "k"`, and "Meta+K" would send key "K".
        await page.keyboard.press("ControlOrMeta+k");
        await expect(page.getByTestId("command-palette")).toBeVisible();
        await shoot(page, theme, "state-cmdk", false, testInfo);
      });

      test("state-menu", async ({}, testInfo) => {
        await page.goto("/inbox");
        await settle(page);
        const toggle = page.locator('[data-testid="theme-toggle"]');
        await toggle.click();
        // Before the Light/Dark/System menu (main @ 7e4fcd6) the toggle was a
        // plain button; only expect a menu when the trigger says it opens one.
        if ((await toggle.getAttribute("aria-haspopup")) === "menu") {
          await expect(page.getByRole("menu")).toBeVisible();
        }
        await shoot(page, theme, "state-menu", false, testInfo);
      });

      test("state-dialog", async ({}, testInfo) => {
        // Admins are redirected to /admin/api-keys, whose create button reads
        // "Generate new key" — its test id still names the token dialog.
        await page.goto("/account/tokens");
        await settle(page);
        await page
          .getByRole("button", { name: /token/i })
          .or(page.getByTestId("create-token-button"))
          .first()
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await shoot(page, theme, "state-dialog", false, testInfo);
      });
    });
  }

  // Its own test so a `before` run on a pre-system-theme `main` fails only here.
  test("system theme follows prefers-color-scheme", async ({ browser }) => {
    for (const colorScheme of ["dark", "light"] as const) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme });
      try {
        const p = await ctx.newPage();
        await p.goto("/login");
        const html = p.locator("html");
        if (colorScheme === "dark") {
          await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
        } else {
          await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
        }
      } finally {
        await ctx.close();
      }
    }
  });
});
