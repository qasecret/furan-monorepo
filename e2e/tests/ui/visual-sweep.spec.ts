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
  type Response,
  type TestInfo,
} from "@playwright/test";

import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_PASSWORD,
  USER_PASSWORD,
} from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import { API_URL as API } from "../../src/env.js";
import { loadSeed, principal } from "../../src/seed/load-seed.js";
import {
  ensureVisualFixture,
  type VisualFixture,
} from "../../src/visual/fixture.js";
import { timeMasks } from "../../src/visual/masks.js";
import { DISCOVERED, STATES, staticRoutes } from "../../src/visual/routes.js";
import { unclip } from "../../src/visual/unclip.js";
import { uploadShots } from "../../src/visual/upload.js";

/**
 * Visual sweep (design-foundation spec §7.1): every dashboard route, in light
 * and dark, as a full-page 1440-wide screenshot plus an axe `color-contrast`
 * pass. The page is un-clipped first (src/visual/unclip.ts) so both see the
 * whole page, not just the first 900px the app's own scroll containers show.
 * Run once on `main` (`VISUAL_LABEL=before-…`) and once on the branch
 * (`VISUAL_LABEL=after-…`) and compare the two PNG sets — see e2e/README.md.
 *
 * Not part of `s3-full`: tagged `@visual`, run with `--project=visual`.
 */

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const LABEL = process.env.VISUAL_LABEL ?? "local";
/** Upload branch: stable across runs so a `before` baseline approved in Furan
 *  is the one the `after` build diffs against (baselines are branch-scoped). */
const UPLOAD_BRANCH = process.env.FURAN_VISUAL_BRANCH ?? "visual-sweep";
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
  /** The path the sweep navigated to. */
  path: string;
  /** Where it actually landed, after redirects. */
  landedPath: string;
  /** axe violation nodes. */
  nodes: number;
  /** Nodes axe could not measure because they lie outside the viewport. */
  outsideViewport: number;
  examples: string[];
}

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type AxeRule = AxeResults["violations"][number];
type AxeNode = AxeRule["nodes"][number];

/** One colour-contrast problem on one node, for annotations and the summary. */
interface Problem {
  route: string;
  rule: string;
  selector: string;
  /** "#fg on #bg = 3.2:1 (needs 4.5:1)", or why it couldn't be measured. */
  detail: string;
}

function problem(route: string, rule: string, n: AxeNode): Problem {
  const d = (n.any[0]?.data ?? {}) as {
    fgColor?: string;
    bgColor?: string;
    contrastRatio?: number;
    expectedContrastRatio?: string;
    messageKey?: string;
  };
  const detail =
    d.messageKey === "outsideViewport"
      ? "not measured: outside the viewport"
      : `${d.fgColor ?? "?"} on ${d.bgColor ?? "?"} = ${d.contrastRatio ?? "?"}:1 (needs ${d.expectedContrastRatio ?? "?"})`;
  return { route, rule, selector: n.target.join(" "), detail };
}

const isOutsideViewport = (n: AxeNode): boolean =>
  n.any.some(
    (c) =>
      (c.data as { messageKey?: string } | null)?.messageKey ===
      "outsideViewport",
  );

/**
 * A route's colour-contrast problems: every violation node, plus every
 * `incomplete` node axe skipped as outside the viewport — on a page taller
 * than the viewport, "couldn't check" must not pass as "fine".
 */
function contrastProblems(
  route: string,
  r: AxeResults,
): { violations: Problem[]; outsideViewport: Problem[] } {
  const each = (rules: AxeRule[], keep: (n: AxeNode) => boolean) =>
    rules.flatMap((rule) =>
      rule.nodes.filter(keep).map((n) => problem(route, rule.id, n)),
    );
  return {
    violations: each(r.violations, () => true),
    outsideViewport: each(r.incomplete, isOutsideViewport),
  };
}

const formatProblem = (p: Problem): string =>
  `${p.route} · ${p.rule} · ${p.selector} · ${p.detail}`;

/** A navigation the sweep made: where it went and the server's answer. */
interface Visit {
  path: string;
  response: Response | null;
}

async function visit(p: Page, path: string): Promise<Visit> {
  return { path, response: await p.goto(path) };
}

/** Log in through the dashboard's form, as tests/ui/dashboard.spec.ts does. */
async function logIn(p: Page, email: string, password: string): Promise<void> {
  await p.goto("/login");
  await p.fill("#email", email);
  await p.fill("#password", password);
  await p.click('button[type="submit"]');
  // Generous: a dashboard dev server may compile the login action first.
  await p.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 60_000,
  });
}

test.describe.serial("visual sweep @visual", () => {
  // A dashboard dev server compiles a route on first visit and again after it
  // has idled out, which on a busy machine can take minutes (seen: 2m for
  // /analytics); one slow compile must not sink the whole serial sweep.
  test.describe.configure({ timeout: 300_000 });

  const api = new ApiClient(API);
  let fixture: VisualFixture;
  let context: BrowserContext;
  let editor: BrowserContext;
  let anon: BrowserContext;
  let page: Page;
  let editorPage: Page;
  let anonPage: Page;
  const shots: { name: string; png: Buffer }[] = [];
  const contrast: Contrast[] = [];
  /** Problems on `enforceContrast` shots, failed once per theme at the end. */
  const enforced: Record<Theme, Problem[]> = { light: [], dark: [] };
  /** Uncaught page errors since the current test started (all sessions). */
  const pageErrors: string[] = [];

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    fixture = await ensureVisualFixture(api);

    context = await browser.newContext({ viewport: VIEWPORT });
    await steady(context);
    page = await context.newPage();
    await logIn(page, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);

    // Admins are redirected off the non-admin routes (`as: "editor"`), so
    // those are captured from a seeded editor's session.
    editor = await browser.newContext({ viewport: VIEWPORT });
    await steady(editor);
    editorPage = await editor.newPage();
    await logIn(
      editorPage,
      principal(loadSeed(), "editor").email,
      USER_PASSWORD,
    );

    anon = await browser.newContext({ viewport: VIEWPORT });
    await steady(anon);
    anonPage = await anon.newPage();

    // Hiding Next's dev overlay (DEV_OVERLAY) also hides its error dialog, so
    // record uncaught page errors per test instead of losing them.
    for (const p of [page, editorPage, anonPage]) {
      p.on("pageerror", (err) => {
        pageErrors.push(`${new URL(p.url()).pathname}: ${err.message}`);
      });
    }
  });

  test.beforeEach(() => {
    pageErrors.length = 0;
  });

  test.afterEach(({}, testInfo) => {
    for (const description of pageErrors.splice(0)) {
      testInfo.annotations.push({ type: "pageerror", description });
    }
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
        branch: UPLOAD_BRANCH,
        buildName: `sweep-${LABEL}`,
        shots,
      });
      console.log(`[visual] uploaded ${shots.length} shots → build ${buildId}`);
    }
    await context?.close();
    await editor?.close();
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

  /**
   * Check the navigation, settle, un-clip, then screenshot, save, and run axe
   * colour-contrast. A 4xx/5xx answer fails the test (an error page must not
   * pass as a screen); landing somewhere other than `v.path` is annotated
   * (`landed-elsewhere`), not failed — several routes redirect by design.
   * Contrast problems are annotated; on an `enforceContrast` shot they are
   * also collected for the theme's `contrast-enforced` check.
   */
  async function shoot(
    p: Page,
    v: Visit,
    theme: Theme,
    name: string,
    enforceContrast: boolean,
    testInfo: TestInfo,
  ): Promise<void> {
    // No response = a same-document navigation, which is fine.
    const status = v.response?.status() ?? 200;
    expect(status, `GET ${v.path} answered ${status}`).toBeLessThan(400);
    // Park the pointer in a corner: wherever an earlier click left it, it
    // would otherwise hover (and highlight) whatever this page puts there.
    await p.mouse.move(VIEWPORT.width - 1, VIEWPORT.height - 1);
    await settle(p);
    const landedPath = new URL(p.url()).pathname;
    if (landedPath !== v.path) {
      testInfo.annotations.push({
        type: "landed-elsewhere",
        description: `${v.path} → ${landedPath}`,
      });
    }
    await unclip(p);
    const png = await stableScreenshot(p);
    const file = join(OUT, theme, `${name}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    shots.push({ name: `${theme}/${name}`, png });

    const results = await new AxeBuilder({ page: p })
      .withRules(["color-contrast"])
      .exclude(DEV_OVERLAY)
      .analyze();
    const { violations, outsideViewport } = contrastProblems(name, results);
    const problems = [...violations, ...outsideViewport];
    const examples = problems
      .slice(0, 5)
      .map((x) => `${x.detail} at ${x.selector}`);
    contrast.push({
      theme,
      route: name,
      path: v.path,
      landedPath,
      nodes: violations.length,
      outsideViewport: outsideViewport.length,
      examples,
    });
    testInfo.annotations.push({
      type: enforceContrast ? "color-contrast-enforced" : "color-contrast",
      description: `${violations.length} violation(s), ${outsideViewport.length} outside the viewport${examples.length ? ` — ${examples.join("; ")}` : ""}`,
    });
    if (enforceContrast) enforced[theme].push(...problems);
  }

  for (const theme of THEMES) {
    test.describe(theme, () => {
      const disposers: { dispose(): Promise<void> }[] = [];

      // Every document in every context starts with this theme stored, exactly
      // as if the user had picked it in the toggle. Disposed after the theme so
      // the next theme's script is the only one (init-script order is undefined).
      test.beforeAll(async () => {
        const content = `try { localStorage.setItem("furan-theme", ${JSON.stringify(theme)}); } catch {}`;
        disposers.push(
          await context.addInitScript({ content }),
          await editor.addInitScript({ content }),
          await anon.addInitScript({ content }),
        );
      });
      test.afterAll(async () => {
        await Promise.all(disposers.splice(0).map((d) => d.dispose()));
      });

      for (const name of STATIC_NAMES) {
        test(name, async ({}, testInfo) => {
          const route = staticRoutes(fixture).find((r) => r.name === name)!;
          const p = PUBLIC_PATHS.has(route.path)
            ? anonPage
            : route.as === "editor"
              ? editorPage
              : page;
          const v = await visit(p, route.path);
          await shoot(p, v, theme, route.name, route.enforceContrast, testInfo);
        });
      }

      for (const d of DISCOVERED) {
        test(d.name, async ({}, testInfo) => {
          let v = await visit(page, d.from(fixture));
          for (const hop of [...(d.via ?? []), d.href]) {
            await settle(page);
            const href = await firstLink(page, hop);
            v = await visit(page, new URL(href, page.url()).pathname);
          }
          await shoot(page, v, theme, d.name, d.enforceContrast, testInfo);
        });
      }

      for (const s of STATES) {
        test(s.name, async ({}, testInfo) => {
          const p = s.as === "editor" ? editorPage : page;
          const v = await visit(p, s.path);
          await settle(p);
          await s.open(p);
          await shoot(p, v, theme, s.name, s.enforceContrast, testInfo);
        });
      }
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

  // The enforceContrast ratchet, checked ONCE per theme with that theme's
  // whole list, instead of failing at the first offending route. It runs
  // last, as soft assertions in one test: a failure inside a serial suite
  // skips every test after it, so a failing check at the end of the light
  // pass would silently drop the entire dark pass.
  test("contrast-enforced", () => {
    for (const theme of THEMES) {
      const found = enforced[theme].map(formatProblem);
      expect
        .soft(
          found,
          `${theme}: ${found.length} colour-contrast problem(s) on enforceContrast shots (route · rule · selector · ratio)`,
        )
        .toEqual([]);
    }
  });
});
