import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { count, eq, inArray, screenshots } from "@furan/db";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

import { BUDGETS, type Measurement } from "../budgets.js";
import {
  complete,
  createBuild,
  createRun,
  seedPat,
  uploadPng,
} from "../clients/sdk.js";
import { InterruptedError, describeError } from "../errors.js";
import {
  generatePng,
  pendingSteps,
  pipelineStep,
  type Seeded,
  type Shape,
} from "../seed/index.js";
import type { Stack } from "../stack/api.js";
import { PROXY_ERROR_HEADER } from "../stack/proxy.js";
import { percentile } from "../stats.js";

import {
  countBrowserFailures,
  offscreenImages,
  refetchesPerQuery,
  storageKeyOf,
  unpackTrpcCalls,
  unpackTrpcPaths,
  walkPlan,
  type BrowserFailureCount,
  type FailedRequest,
  type FailedResponse,
} from "./browser-math.js";
import { openQueueProbe, type QueueProbe } from "./pipeline-probes.js";

export {
  countBrowserFailures,
  offscreenImages,
  refetchesPerQuery,
  routeShape,
  storageKeyOf,
  unpackTrpcCalls,
  unpackTrpcPaths,
  walkPlan,
} from "./browser-math.js";

/**
 * The browser suite (spec §5.4): D1–D5, with Chromium against the production
 * dashboard behind the single-origin proxy, as a reviewer.
 *
 * - **Login** once, through the form, as reviewer 0 (the one seeded user with
 *   a password; the login throttle allows a handful a minute). Every
 *   measurement then gets a new context with that session: a cold HTTP cache,
 *   already signed in, tours reported dismissed (the e2e `NO_TOURS` script).
 * - **Order**: D1 and D2 on the project as seeded, D5 (read-only), then D3
 *   (one approve) and D4 (a new batch, uploads and diffs), so a mutation never
 *   lands before a read that it would change, and the diff queue is idle for
 *   everything but D4. D4 leaves the queue idle again for the next suite.
 * - **Timing** is `performance.now()` inside the page, from the navigation's
 *   start (or the key press) to the moment the awaited element is in the DOM,
 *   recorded by a MutationObserver installed before the page's own scripts.
 * - A measurement that fails marks only its own budgets `error`.
 *
 * The procedures the viewer requests while it opens (D5) are R4's call set:
 * returned for the server suite and written to `<report dir>/viewer-calls.json`.
 * Every failed request of every context the suite opens is R8's browser share
 * (Ruling R36, `countBrowserFailures`), handed to `onFailures` at the end.
 */

const VIEWPORT = { width: 1440, height: 900 } as const;
/** How long a page may take to show what a measurement waits for. */
const SELECTOR_TIMEOUT_MS = 60_000;
/** The network counts as settled after this long with nothing in flight. */
const QUIET_MS = 500;
/** ... or, failing that, after this long (a page that keeps polling). */
const QUIET_CAP_MS = 20_000;
/** D3: what is counted after the approve. */
const D3_WINDOW_MS = 3_000;
/** D4: the refetch window, and the longest recording. */
const D4_WINDOW_MS = 3_000;
const D4_RECORD_MS = 60_000;
/**
 * D4: the recording runs on past the diff queue going idle for the project
 * events' trailing frame (the api's debouncer holds one for at most 3 s) and
 * the refetch it causes.
 */
const D4_TRAILING_MS = 4_000;
/** After D4, how long the diff queue may take to empty (twice, see `drain`). */
const DRAIN_TIMEOUT_MS = 5 * 60_000;
/** D5: step moves timed, and how long one may take. */
const D5_MOVES = 50;
const STEP_TIMEOUT_MS = 30_000;
/** D3: the most cursor moves to reach the step to approve. */
const MAX_CURSOR_MOVES = 200;
/** D4 uploads steps of this set, so they diff against its seeded baselines. */
const D4_SET = "pipeline-500" as const;

/** The rows the e2e specs wait for (`inbox-batch-row-<id>`, `result-row-<id>`). */
const BATCH_ROW = '[data-testid^="inbox-batch-row-"]';
const RUN_ROW = '[data-testid^="result-row-"]';
const STEP_CARD_PREFIX = "step-card-";

const IDS = BUDGETS.filter((b) => b.suite === "browser").map((b) => b.id);

/**
 * First-visit page tours open over the page behind a scrim that takes the
 * clicks and keys until dismissed; dismissal lives in localStorage per page
 * (`furan:tour:dismissed:<pageId>`). Report every tour as already dismissed,
 * as the e2e UI specs do.
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
 * An init script: records in `window.__scaleMarks[name]` the
 * `performance.now()` at which `selector` first matches, so the time counts
 * from the navigation's start (the document's time origin).
 */
function markWhenPresent(name: string, selector: string): string {
  return `(() => {
  const marks = (window.__scaleMarks = window.__scaleMarks || {});
  const name = ${JSON.stringify(name)};
  const selector = ${JSON.stringify(selector)};
  const check = () => {
    if (marks[name] === undefined && document.querySelector(selector)) {
      marks[name] = performance.now();
    }
    return marks[name] !== undefined;
  };
  if (check()) return;
  const observer = new MutationObserver(() => {
    if (check()) observer.disconnect();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-testid", "data-stage-drawn"],
  });
})();`;
}

/** Two frames: whatever a change scheduled has been laid out and painted. */
const TWO_FRAMES =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))";

/** The batch list's own scroll container, or the document's. */
const FIND_SCROLLER = `(() => {
  const list = document.querySelector('[data-testid="batch-results"]');
  for (let el = list && list.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return document.scrollingElement || document.documentElement;
})()`;

const DOM_ELEMENTS = `document.getElementsByTagName("*").length`;

/**
 * The step cards whose box, clipped by every scrolling or clipping ancestor,
 * intersects the viewport: their checkpoint ids, in page order.
 */
const VISIBLE_CARDS = `(() => {
  const prefix = ${JSON.stringify(STEP_CARD_PREFIX)};
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    let l = Math.max(r.left, 0), t = Math.max(r.top, 0);
    let rr = Math.min(r.right, vw), b = Math.min(r.bottom, vh);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const ar = a.getBoundingClientRect();
      l = Math.max(l, ar.left); t = Math.max(t, ar.top);
      rr = Math.min(rr, ar.right); b = Math.min(b, ar.bottom);
    }
    return rr > l && b > t;
  };
  return Array.from(document.querySelectorAll('[data-testid^="' + prefix + '"]'))
    .filter(shown)
    .map((el) => el.getAttribute("data-testid").slice(prefix.length));
})()`;

/** Scrolls the batch list to `fraction` of its range; says where it went. */
const scrollTo = (fraction: number): string => `(() => {
  const s = ${FIND_SCROLLER};
  const range = Math.max(0, s.scrollHeight - s.clientHeight);
  s.scrollTop = ${fraction} * range;
  return { top: Math.round(s.scrollTop), range: Math.round(range) };
})()`;

type SessionState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface BrowserSuiteOptions {
  /** D4's run is the shape's `pipeline-500` set (500 steps, 10 on smoke). */
  shape: Shape;
  /** Where `viewer-calls.json` goes: the report directory. */
  outDir: string;
  /**
   * Gets R8's browser share once the browser has closed, also when the suite
   * stopped early (a failed login is when a 5xx matters most).
   */
  onFailures?: (failures: BrowserFailures) => void;
}

/** R8's browser share: what to add, and the note's words for it. */
export interface BrowserFailures {
  count: number;
  note: string;
}

export interface BrowserSuiteResult {
  measurements: Measurement[];
  /**
   * The procedure paths the viewer requested while it opened (D5), in the
   * order first requested; undefined when D5 could not open the viewer, so
   * the server suite falls back to the checked-in list.
   */
  viewerCalls?: string[];
}

/** The file the recorded call set is written to, in the report directory. */
export const VIEWER_CALLS_FILE = "viewer-calls.json";

export async function runBrowserSuite(
  stack: Stack,
  seeded: Seeded,
  origin: string,
  opts: BrowserSuiteOptions,
): Promise<BrowserSuiteResult> {
  const alive = (): void => {
    if (stack.teardown.closing) throw new InterruptedError();
  };
  const out = new Map<string, Measurement>();
  const measure = async (
    ids: readonly string[],
    fn: () => Promise<Measurement[]>,
  ): Promise<void> => {
    alive();
    try {
      for (const m of await fn()) out.set(m.id, m);
    } catch (error) {
      if (error instanceof InterruptedError || stack.teardown.closing) {
        throw error;
      }
      for (const id of ids) {
        out.set(id, { id, value: null, error: brief(error) });
      }
    }
  };

  // A recording from an earlier run must not pass for this one's.
  const callsFile = path.join(opts.outDir, VIEWER_CALLS_FILE);
  rmSync(callsFile, { force: true });

  // Playwright's own signal handlers would close the browser on Ctrl-C and
  // skip the harness's teardown: the harness closes it.
  const browser = await chromium.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  stack.teardown.add("close the browser", () => browser.close());
  const failures = new FailureLog();
  let viewerCalls: string[] | undefined;
  try {
    const session = await logIn(browser, origin, seeded.browserLogin, failures);
    const s: Session = {
      browser,
      session,
      origin,
      stack,
      seeded,
      alive,
      failures,
    };

    await measure(["D1"], () => measureBatches(s));
    await measure(
      ["D2.firstRow", "D2.domMax", "D2.offscreenImages", "D2.imageKB"],
      () => measureBatch(s),
    );
    await measure(["D5.open", "D5.next"], async () => {
      const viewer = await measureViewer(s);
      viewerCalls = viewer.calls;
      return viewer.measurements;
    });
    await measure(["D3.calls", "D3.refetches"], () => measureApprove(s));
    await measure(["D4"], () => measureLiveUpdates(s, opts.shape));
  } finally {
    await browser.close();
    opts.onFailures?.(failures.summary());
  }

  if (viewerCalls !== undefined) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(callsFile, `${JSON.stringify(viewerCalls, null, 2)}\n`);
  }
  return {
    measurements: IDS.map(
      (id) => out.get(id) ?? { id, value: null, error: "not measured" },
    ),
    ...(viewerCalls !== undefined && { viewerCalls }),
  };
}

// ---------------------------------------------------------------------------
// Sessions and the network log
// ---------------------------------------------------------------------------

interface Session {
  browser: Browser;
  session: SessionState;
  origin: string;
  stack: Stack;
  seeded: Seeded;
  alive: () => void;
  failures: FailureLog;
}

/**
 * Every failing response and failed request of the contexts the suite opens
 * (Ruling R36). A context is marked as closing before the suite closes it, so
 * the requests that closing cancels are told apart from the page's own
 * cancellations; neither is a failure (`countBrowserFailures`).
 */
class FailureLog {
  private readonly responses: FailedResponse[] = [];
  private readonly failed: FailedRequest[] = [];

  /** Watches `context`; call the result just before closing it. */
  watch(context: BrowserContext): () => void {
    let closing = false;
    context.on("response", (response) => {
      const status = response.status();
      if (status >= 500 || status === 413 || status === 414 || status === 431) {
        this.responses.push({
          url: response.url(),
          status,
          byProxy: response.headers()[PROXY_ERROR_HEADER] !== undefined,
        });
      }
    });
    context.on("requestfailed", (request) => {
      this.failed.push({
        url: request.url(),
        errorText: request.failure()?.errorText ?? "unknown error",
        closing,
      });
    });
    return () => {
      closing = true;
    };
  }

  summary(): BrowserFailures {
    return describeFailures(countBrowserFailures(this.responses, this.failed));
  }
}

/** R8's note for the browser share. */
function describeFailures(c: BrowserFailureCount): BrowserFailures {
  const parts = [
    c.count === 0 ? "none" : c.sample.join(", "),
    ...(c.inHistogram > 0
      ? [`${c.inHistogram} api 5xx left to its histogram, which counts them`]
      : []),
    `cancellations not counted: ${c.aborted.page} by the page, ${c.aborted.suite} by the suite closing its contexts`,
  ];
  return { count: c.count, note: parts.join("; ") };
}

/** A Playwright error's first lines, without its call log. */
function brief(error: unknown): string {
  const text = describeError(error).split("\nCall log:")[0] ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

const round = (n: number, places = 1): number =>
  Math.round(n * 10 ** places) / 10 ** places;

/** Logs in once through the form and returns the signed-in session. */
async function logIn(
  browser: Browser,
  origin: string,
  login: Seeded["browserLogin"],
  failures: FailureLog,
): Promise<SessionState> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    reducedMotion: "reduce",
  });
  const closing = failures.watch(context);
  try {
    await context.addInitScript({ content: NO_TOURS });
    const page = await context.newPage();
    page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);
    await page.goto(`${origin}/login`);
    await page.fill("#email", login.email);
    await page.fill("#password", login.password);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: SELECTOR_TIMEOUT_MS,
    });
    return await context.storageState();
  } catch (error) {
    throw new Error(`logging in through the dashboard failed: ${brief(error)}`);
  } finally {
    closing();
    await context.close();
  }
}

/** One request the page made, with the harness's clock when it was sent. */
interface Logged {
  url: string;
  method: string;
  t: number;
  request: Request;
  /** Set when it ended without an answer (cancelled, or the connection failed). */
  failed?: true;
}

/** A procedure call of a tRPC request, with its request's time and method. */
interface LoggedCall {
  path: string;
  input: string;
  method: string;
  t: number;
  /** Its request ended without an answer (see `Logged.failed`). */
  failed: boolean;
}

/** The project and run event streams: open for as long as the page is. */
const EVENT_STREAM = /\/v1\/(projects|runs)\/[^/]+\/events$/;

/**
 * Every request a page makes, and what is in flight (event streams aside).
 * Storage responses' sizes on the wire are read as they finish.
 */
class NetworkLog {
  readonly entries: Logged[] = [];
  private readonly inFlight = new Set<Request>();
  private lastChange = performance.now();
  private readonly sizes: Promise<number | null>[] = [];

  constructor(page: Page) {
    page.on("request", (request) => {
      const url = request.url();
      this.entries.push({
        url,
        method: request.method(),
        t: performance.now(),
        request,
      });
      if (!EVENT_STREAM.test(new URL(url).pathname)) {
        this.inFlight.add(request);
        this.lastChange = performance.now();
      }
    });
    const done = (request: Request): void => {
      if (this.inFlight.delete(request)) this.lastChange = performance.now();
    };
    page.on("requestfinished", (request) => {
      done(request);
      if (storageKeyOf(request.url()) !== null) {
        this.sizes.push(
          request.sizes().then(
            (s) => s.responseBodySize,
            () => null,
          ),
        );
      }
    });
    page.on("requestfailed", (request) => {
      done(request);
      const entry = this.entries.find((e) => e.request === request);
      if (entry !== undefined) entry.failed = true;
    });
  }

  /**
   * Waits until nothing has been in flight for `QUIET_MS`; gives up (false)
   * after `QUIET_CAP_MS`.
   */
  async quiet(): Promise<boolean> {
    const deadline = performance.now() + QUIET_CAP_MS;
    for (;;) {
      const now = performance.now();
      if (this.inFlight.size === 0 && now - this.lastChange >= QUIET_MS) {
        return true;
      }
      if (now >= deadline) return false;
      await sleep(50);
    }
  }

  /** Every procedure call of the tRPC requests sent in `[from, to)`. */
  trpcCalls(from = -Infinity, to = Infinity): LoggedCall[] {
    return this.entries
      .filter((e) => e.t >= from && e.t < to)
      .flatMap((e) =>
        unpackTrpcCalls(e.url).map((call) => ({
          ...call,
          method: e.method,
          t: e.t,
          failed: e.failed === true,
        })),
      );
  }

  /** The storage-proxy requests sent before `to`. */
  storage(to = Infinity): Logged[] {
    return this.entries.filter((e) => e.t < to && storageKeyOf(e.url) !== null);
  }

  /** Body bytes on the wire of every storage response that came over the network. */
  async storageBytes(): Promise<number[]> {
    const sizes = await Promise.all(this.sizes);
    return sizes.filter((n): n is number => n !== null && n > 0);
  }
}

/**
 * A new context with the signed-in session (so a cold HTTP cache), the
 * suite's viewport and reduced motion, tours dismissed, `scripts` installed
 * before any of the page's own; `fn` gets its page and network log.
 */
async function withPage<T>(
  s: Session,
  scripts: readonly string[],
  fn: (page: Page, log: NetworkLog) => Promise<T>,
): Promise<T> {
  s.alive();
  const context = await s.browser.newContext({
    viewport: VIEWPORT,
    reducedMotion: "reduce",
    storageState: s.session,
  });
  const closing = s.failures.watch(context);
  try {
    await context.addInitScript({ content: NO_TOURS });
    for (const script of scripts) {
      await context.addInitScript({ content: script });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);
    return await fn(page, new NetworkLog(page));
  } finally {
    closing();
    await context.close().catch(() => undefined);
  }
}

/**
 * Polls `expression` in the page until it is true. From here, not with
 * `waitForFunction`: that evaluates its predicate with the page's `eval`,
 * which the dashboard's CSP forbids. The poll's interval costs no precision:
 * the times are taken in the page.
 */
async function untilInPage(
  page: Page,
  expression: string,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await page.evaluate<boolean>(`Boolean(${expression})`))) {
    if (performance.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs / 1000} s waiting for ${what}`,
      );
    }
    await sleep(20);
  }
}

/** `window.__scaleMarks[name]`: ms from the navigation's start. */
async function readMark(page: Page, name: string): Promise<number> {
  const value = await page.evaluate<number | null>(
    `(window.__scaleMarks || {})[${JSON.stringify(name)}] ?? null`,
  );
  if (value === null) throw new Error(`the page recorded no time for ${name}`);
  return value;
}

/** Calls per path, most first: `runs.list ×2, builds.getById ×1`. */
function tally(calls: readonly { path: string }[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
  return (
    [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([p, n]) => `${p} ×${n}`)
      .join(", ") || "none"
  );
}

/** How many of `calls` went out and were cancelled (or failed) without an answer. */
const unansweredNote = (calls: readonly LoggedCall[]): string => {
  const n = calls.filter((c) => c.failed).length;
  return n > 0
    ? `; ${n} of these calls ended without an answer (cancelled)`
    : "";
};

/**
 * Presses `key` until `target` has focus, at most `max` times (the batch
 * list's cursor moves focus one item per press), and says how many it took.
 */
async function pressUntilFocused(
  page: Page,
  key: string,
  target: Locator,
  max: number,
): Promise<number> {
  const focused = async (): Promise<boolean> =>
    (await target.and(page.locator(":focus")).count()) === 1;
  for (let presses = 0; presses <= max; presses += 1) {
    if (await focused()) return presses;
    if (presses < max) await page.keyboard.press(key);
  }
  throw new Error(`"${key}" did not bring focus to the step in ${max} presses`);
}

// ---------------------------------------------------------------------------
// D1: the batches page
// ---------------------------------------------------------------------------

async function measureBatches(s: Session): Promise<Measurement[]> {
  return withPage(s, [markWhenPresent("row", BATCH_ROW)], async (page) => {
    await page.goto(`${s.origin}/inbox`, { waitUntil: "commit" });
    await page.waitForSelector(BATCH_ROW, { state: "visible" });
    const ms = await readMark(page, "row");
    const rows = await page.locator(BATCH_ROW).count();
    return [
      {
        id: "D1",
        value: round(ms),
        samples: 1,
        note: `/inbox at its default view, one cold navigation; ${rows} batch rows when the first appeared`,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// D2: the newest batch
// ---------------------------------------------------------------------------

/** The image key of each checkpoint, in the order given (one per id). */
async function imageKeysOf(
  s: Session,
  checkpointIds: readonly string[],
): Promise<string[]> {
  if (checkpointIds.length === 0) return [];
  const rows = await s.stack.db
    .select({ id: screenshots.id, imageKey: screenshots.imageKey })
    .from(screenshots)
    .where(inArray(screenshots.id, [...new Set(checkpointIds)]));
  const byId = new Map(rows.map((r) => [r.id, r.imageKey]));
  return checkpointIds.flatMap((id) => {
    const key = byId.get(id);
    return key ? [key] : [];
  });
}

async function measureBatch(s: Session): Promise<Measurement[]> {
  const { projectId, newestBuildId } = s.seeded;
  return withPage(s, [markWhenPresent("row", RUN_ROW)], async (page, log) => {
    await page.goto(
      `${s.origin}/projects/${projectId}/builds/${newestBuildId}`,
      {
        waitUntil: "commit",
      },
    );
    await page.waitForSelector(RUN_ROW, { state: "visible" });
    const firstRow = await readMark(page, "row");

    // The top, once the page has loaded what it loads on its own.
    const settled = await log.quiet();
    const topAt = performance.now();
    const counts = [await page.evaluate<number>(DOM_ELEMENTS)];
    const visible = await page.evaluate<string[]>(VISIBLE_CARDS);
    const cards = await page
      .locator(`[data-testid^="${STEP_CARD_PREFIX}"]`)
      .count();
    const runs = await page.locator(RUN_ROW).count();
    const topRequests = log.storage(topAt);

    // The middle and the bottom of the list.
    const positions: string[] = [];
    for (const fraction of [0.5, 1]) {
      const at = await page.evaluate<{ top: number; range: number }>(
        scrollTo(fraction),
      );
      await page.evaluate(TWO_FRAMES);
      await log.quiet();
      counts.push(await page.evaluate<number>(DOM_ELEMENTS));
      positions.push(`${at.top}/${at.range} px`);
    }

    const keys = await imageKeysOf(s, visible);
    const offscreen = offscreenImages(topRequests, keys);
    const bytes = await log.storageBytes();
    const sizes = [...bytes].sort((a, b) => a - b);
    const where = `the newest batch at its default view (Needs review): ${runs} run rows, ${cards} step cards`;
    return [
      {
        id: "D2.firstRow",
        value: round(firstRow),
        samples: 1,
        note: `${where}; one cold navigation`,
      },
      {
        id: "D2.domMax",
        value: Math.max(...counts),
        note: `top ${counts[0]}, middle ${counts[1]} (${positions[0]}), bottom ${counts[2]} (${positions[1]}) elements${settled ? "" : `; the page was still loading after ${QUIET_CAP_MS / 1000} s`}`,
      },
      {
        id: "D2.offscreenImages",
        value: offscreen,
        note: `${topRequests.length} step-image requests by the time the top had loaded, ${visible.length} cards in the viewport there (each card's image key read from screenshots.image_key by its step-card id)`,
      },
      sizes.length === 0
        ? {
            id: "D2.imageKB",
            value: null,
            note: "no step image came over the network",
          }
        : {
            id: "D2.imageKB",
            value: round((sizes[sizes.length - 1] as number) / 1024),
            samples: sizes.length,
            note: `largest of ${sizes.length} step images fetched (top, middle and bottom), body bytes on the wire; median ${round(percentile(sizes, 50) / 1024)} KB`,
          },
    ];
  });
}

// ---------------------------------------------------------------------------
// D5: the viewer (and R4's call set)
// ---------------------------------------------------------------------------

/**
 * Armed before each step move: records the first key press after it, and
 * when the stage names a step other than `from` as drawn.
 */
const armStepWatch = (from: string): string => `(() => {
  const from = ${JSON.stringify(from)};
  const s = (window.__scaleStep = { keyAt: null, drawnAt: null, id: null });
  window.addEventListener(
    "keydown",
    () => { if (s.keyAt === null) s.keyAt = performance.now(); },
    { capture: true, once: true },
  );
  const check = () => {
    const el = document.querySelector("[data-stage-drawn]");
    const id = el && el.getAttribute("data-stage-drawn");
    if (id && id !== from) {
      s.drawnAt = performance.now();
      s.id = id;
      return true;
    }
    return false;
  };
  const observer = new MutationObserver(() => {
    if (s.drawnAt === null && check()) observer.disconnect();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-stage-drawn"],
  });
})()`;

async function measureViewer(
  s: Session,
): Promise<{ measurements: Measurement[]; calls: string[] }> {
  const { projectId, longRunId, longRunFirstStepId } = s.seeded;
  const [row] = await s.stack.db
    .select({ n: count() })
    .from(screenshots)
    .where(eq(screenshots.runId, longRunId));
  const steps = Number(row?.n ?? 0);
  const plan = walkPlan(steps, D5_MOVES);
  const drawn = `[data-stage-drawn="${longRunFirstStepId}"]`;

  return withPage(s, [markWhenPresent("drawn", drawn)], async (page, log) => {
    await page.goto(
      `${s.origin}/projects/${projectId}/runs/${longRunId}/checkpoints/${longRunFirstStepId}`,
      { waitUntil: "commit" },
    );
    await page.waitForSelector(drawn, { state: "attached" });
    const open = await readMark(page, "drawn");
    // The call set: what the viewer requested to open the step, up to the
    // network settling after it was drawn.
    await log.quiet();
    const calls = [
      ...new Set(log.entries.flatMap((e) => unpackTrpcPaths(e.url))),
    ];
    const opened: Measurement = {
      id: "D5.open",
      value: round(open),
      samples: 1,
      note: `step 1 of the long run (${steps} steps), one cold navigation to data-stage-drawn; meanwhile the viewer requested ${calls.length} procedures (R4's call set)`,
    };

    // A failed walk loses only D5.next: the open and the call set stand.
    let next: Measurement;
    try {
      const samples = await walk(s, page, log, plan, longRunFirstStepId);
      const sorted = [...samples].sort((a, b) => a - b);
      next = {
        id: "D5.next",
        value: round(percentile(sorted, 95)),
        samples: sorted.length,
        note: `p95 over ${sorted.length} step moves with → / ← (the viewer's Next / Previous step; J is the review loop's next pending step, which leaves the run), key press to data-stage-drawn naming the new step${steps <= D5_MOVES ? `; the run has ${steps} steps, so the walk turns back at its ends and revisits steps` : ""}; median ${round(percentile(sorted, 50))} ms`,
      };
    } catch (error) {
      if (error instanceof InterruptedError || s.stack.teardown.closing) {
        throw error;
      }
      next = { id: "D5.next", value: null, error: brief(error) };
    }
    return { calls, measurements: [opened, next] };
  });
}

/**
 * D5's step moves: for each, the time from the key press reaching the page to
 * the stage naming another step as drawn, both on the page's clock.
 */
async function walk(
  s: Session,
  page: Page,
  log: NetworkLog,
  plan: readonly ("next" | "prev")[],
  from: string,
): Promise<number[]> {
  const samples: number[] = [];
  let at = from;
  for (const move of plan) {
    s.alive();
    await page.evaluate(armStepWatch(at));
    await page.keyboard.press(move === "next" ? "ArrowRight" : "ArrowLeft");
    await untilInPage(
      page,
      "window.__scaleStep.drawnAt !== null",
      STEP_TIMEOUT_MS,
      `the next step drawn after "${move === "next" ? "→" : "←"}"`,
    );
    const step = await page.evaluate<{
      keyAt: number | null;
      drawnAt: number;
      id: string;
    }>("window.__scaleStep");
    if (step.keyAt === null) {
      throw new Error("a step move's key press never reached the page");
    }
    samples.push(step.drawnAt - step.keyAt);
    // The step drawn is the one the move routed to.
    await untilInPage(
      page,
      `location.pathname.endsWith(${JSON.stringify(`/checkpoints/${step.id}`)})`,
      STEP_TIMEOUT_MS,
      `the viewer's address to name the step drawn (${step.id})`,
    );
    at = step.id;
    // A reviewer looks at a step before moving on: the next press waits for
    // what this one started (its requests, the prefetch of the next) to end.
    await log.quiet();
  }
  return samples;
}

// ---------------------------------------------------------------------------
// D3: one approve on the batch page
// ---------------------------------------------------------------------------

/**
 * A pending step of the newest batch to approve: the first in capture order
 * that is neither of the server suite's solo starting points (it runs after
 * this suite and needs them pending).
 */
async function approveTarget(s: Session): Promise<string> {
  const reserved = new Set([
    s.seeded.soloSpots.mid.checkpointId,
    s.seeded.soloSpots.last.checkpointId,
  ]);
  const step = (await pendingSteps(s.stack.db, s.seeded.projectId)).find(
    (p) =>
      p.buildId === s.seeded.newestBuildId && !reserved.has(p.checkpointId),
  );
  if (step === undefined) {
    throw new Error(
      "the newest batch has no pending step to approve besides the solo timings' own",
    );
  }
  return step.checkpointId;
}

async function measureApprove(s: Session): Promise<Measurement[]> {
  const target = await approveTarget(s);
  const { projectId, newestBuildId } = s.seeded;
  return withPage(s, [], async (page, log) => {
    await page.goto(
      `${s.origin}/projects/${projectId}/builds/${newestBuildId}`,
    );
    const card = page.getByTestId(`${STEP_CARD_PREFIX}${target}`);
    await card.waitFor({ state: "visible" });
    await log.quiet();
    const moves = await pressUntilFocused(page, "j", card, MAX_CURSOR_MOVES);
    await log.quiet();

    const t0 = performance.now();
    await page.keyboard.press("a");
    await sleep(Math.max(0, t0 + D3_WINDOW_MS - performance.now()));
    const calls = log.trpcCalls(t0, t0 + D3_WINDOW_MS);
    if (!calls.some((c) => c.path === "review.approve")) {
      throw new Error(
        `"a" on the step sent no review.approve within ${D3_WINDOW_MS / 1000} s`,
      );
    }
    const queries = calls.filter((c) => c.method === "GET");
    return [
      {
        id: "D3.calls",
        value: calls.length,
        note: `procedure calls in the ${D3_WINDOW_MS / 1000} s after "a" on a pending step of the newest batch (reached with ${moves} "j" presses), batches unpacked: ${tally(calls)}${unansweredNote(calls)}`,
      },
      {
        id: "D3.refetches",
        value: refetchesPerQuery(queries, D3_WINDOW_MS),
        note: `most requests of one query (path and input) in that window, ${queries.length} query calls in all`,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// D4: an open batch tab while a run uploads and diffs
// ---------------------------------------------------------------------------

/**
 * Leaves the diff queue idle for the next suite: waits for it, and if it does
 * not empty in time drops the waiting jobs and waits for the active ones.
 * Says whether jobs were dropped.
 */
async function drain(queue: QueueProbe): Promise<boolean> {
  if (await queue.waitIdle(DRAIN_TIMEOUT_MS)) return false;
  await queue.dropWaiting();
  if (await queue.waitIdle(DRAIN_TIMEOUT_MS)) return true;
  throw new Error(
    `the diff queue did not empty within ${(2 * DRAIN_TIMEOUT_MS) / 60_000} min after D4`,
  );
}

async function measureLiveUpdates(
  s: Session,
  shape: Shape,
): Promise<Measurement[]> {
  const { stack, seeded } = s;
  const sdkUser = seeded.reviewers[seeded.reviewers.length - 1];
  if (sdkUser === undefined) throw new Error("the seed has no reviewers");
  const total = shape.pipelineSets[D4_SET];
  // Identical to their baselines: the run passes, so it adds no pending step
  // to the review queue the server suite measures next.
  const steps: {
    name: string;
    viewport: string;
    browser: string;
    png: Buffer;
  }[] = [];
  for (let i = 0; i < total; i += 1) {
    const step = pipelineStep(D4_SET, i);
    steps.push({
      ...step,
      png: await generatePng(step.kind, step.seed, "none"),
    });
  }

  const pat = await seedPat(stack.db, sdkUser.id);
  const build = await createBuild(stack.apiUrl, pat, seeded.projectId, {
    branchName: "main",
    name: "scale-d4",
  });
  const run = await createRun(stack.apiUrl, pat, {
    projectId: seeded.projectId,
    buildId: build.id,
    name: "scale-d4",
    branchName: "main",
  });
  const queue = openQueueProbe(s.alive);
  stack.teardown.add("close the browser suite's queue probe", queue.close);

  // Written by the upload loop, read by the recording (and the cleanup).
  const up: { done: number; endedAt?: number; loop?: Promise<void> } = {
    done: 0,
  };
  let measured: Measurement | undefined;
  let failure: unknown;
  try {
    measured = await withPage(s, [], async (page, log) => {
      await page.goto(
        `${s.origin}/projects/${seeded.projectId}/builds/${build.id}?status=all`,
      );
      await page.getByTestId(`result-row-${run.runId}`).waitFor({
        state: "visible",
      });
      await log.quiet();

      // The uploads, from Node, one at a time as the SDK sends them; they
      // stop at the recording's cap.
      const t0 = performance.now();
      const capAt = t0 + D4_RECORD_MS;
      up.loop = (async () => {
        for (const step of steps) {
          if (performance.now() >= capAt) break;
          s.alive();
          await uploadPng(stack.apiUrl, pat, run.runId, step);
          up.done += 1;
        }
        await complete(stack.apiUrl, pat, run.runId);
        up.endedAt = performance.now();
      })();
      await Promise.race([
        up.loop,
        sleep(Math.max(0, capAt - performance.now())),
      ]);
      const uploadsEnded = up.endedAt;
      // Uploading and then diffing: recorded until the diff queue is idle
      // (and the trailing event's refetch), or the cap.
      let idleAt: number | undefined;
      if (uploadsEnded !== undefined) {
        const left = capAt - performance.now();
        if (left > 0 && (await queue.waitIdle(left))) {
          idleAt = performance.now();
        }
      }
      const end = Math.min(capAt, (idleAt ?? capAt) + D4_TRAILING_MS);
      await sleep(Math.max(0, end - performance.now()));
      const uploaded = up.done;
      const queries = log.trpcCalls(t0, end).filter((c) => c.method === "GET");
      const secs = (ms: number): string => `${round(ms / 1000)} s`;
      return {
        id: "D4",
        value: refetchesPerQuery(queries, D4_WINDOW_MS),
        samples: queries.length,
        note: `most requests of one query (path and input) in a ${D4_WINDOW_MS / 1000} s window, over ${secs(end - t0)} of a batch tab (status All) while a ${total}-step run uploaded (${uploaded} uploads${uploadsEnded === undefined ? `, cut at ${secs(D4_RECORD_MS)}` : ` in ${secs(uploadsEnded - t0)}`}) and diffed${idleAt === undefined ? "" : ` (queue idle after ${secs(idleAt - t0)})`}; ${tally(queries)}${unansweredNote(queries)}`,
      };
    });
  } catch (error) {
    failure = error;
  }

  // The uploads stop at the cap; let them, then leave the queue idle for the
  // next suite, whatever happened above.
  await up.loop?.catch((error: unknown) => {
    failure ??= error;
  });
  try {
    if (await drain(queue)) {
      const note =
        "D4's remaining diff jobs were dropped to leave the queue idle";
      if (measured !== undefined) {
        measured = { ...measured, note: `${measured.note ?? ""}; ${note}` };
      }
    }
  } catch (error) {
    failure ??= error;
  } finally {
    await queue.close();
  }
  if (failure !== undefined) throw failure;
  if (measured === undefined) throw new Error("D4 was not measured");
  return [measured];
}
