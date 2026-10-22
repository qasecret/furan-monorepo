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
  COLD_NAVIGATIONS,
  LIST_PROCEDURES,
  busiestQuery,
  countBrowserFailures,
  listQueries,
  offscreenImages,
  p95Of,
  queryLabel,
  refetchesPerQuery,
  storageKeyOf,
  unpackTrpcCalls,
  unpackTrpcPaths,
  walkPlan,
  warmThenTime,
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
 *   start (or the key press) to the frame that shows the awaited element
 *   painted, recorded by a MutationObserver installed before the page's own
 *   scripts. D1, D2.firstRow and D5.open are each a p95 over cold navigations
 *   (`COLD_NAVIGATIONS` per shape), each in a new context, after one untimed
 *   warm-up navigation of the route (Ruling R46).
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
/** D5: untimed moves first (spec §2.1's warm-ups). */
const D5_WARMUPS = 5;
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
 * An init script: records the `performance.now()` at which `selector` first
 * matches (`window.__scaleMarks[name + ":dom"]`), then, two animation frames
 * later, once the frame holding it has been painted
 * (`window.__scaleMarks[name]`): the time counts from the navigation's start
 * (the document's time origin) to the element on screen.
 */
function markWhenPresent(name: string, selector: string): string {
  return `(() => {
  const marks = (window.__scaleMarks = window.__scaleMarks || {});
  const name = ${JSON.stringify(name)};
  const selector = ${JSON.stringify(selector)};
  const check = () => {
    if (marks[name + ":dom"] === undefined && document.querySelector(selector)) {
      marks[name + ":dom"] = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          marks[name] = performance.now();
        }),
      );
    }
    return marks[name + ":dom"] !== undefined;
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
      navigations: COLD_NAVIGATIONS[opts.shape.name],
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
    try {
      // A browser that will not close is the teardown's to retry and report;
      // it must not lose what was measured.
      await browser.close().catch(() => undefined);
    } finally {
      opts.onFailures?.(failures.summary());
    }
  }

  if (viewerCalls !== undefined) {
    try {
      mkdirSync(opts.outDir, { recursive: true });
      writeFileSync(callsFile, `${JSON.stringify(viewerCalls, null, 2)}\n`);
    } catch (error) {
      // The calls still reach the server suite; only the file is missing.
      const open = out.get("D5.open");
      if (open !== undefined) {
        out.set("D5.open", {
          ...open,
          note: `${open.note ?? ""}; writing ${VIEWER_CALLS_FILE} failed: ${brief(error)}`,
        });
      }
    }
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
  /** Timed cold navigations per first-paint budget (Ruling R46). */
  navigations: number;
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
  /** The harness clock (`performance.now()`) when the page sent it. */
  t: number;
  /** The wall clock (ms since the epoch) when the harness heard of it. */
  at: number;
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
        at: Date.now(),
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
  /**
   * Every procedure call of the tRPC requests the browser started in
   * `[from, to)`, wall clock (ms since the epoch). The time is the browser's
   * own request start, which Playwright fills in once the response has come
   * (so read this after the network has settled); a request that got no
   * response falls back to when the harness heard of it.
   */
  trpcCalls(from = -Infinity, to = Infinity): LoggedCall[] {
    return this.entries.flatMap((e) => {
      const started = e.request.timing().startTime;
      const t = started > 0 ? started : e.at;
      if (t < from || t >= to) return [];
      return unpackTrpcCalls(e.url).map((call) => ({
        ...call,
        method: e.method,
        t,
        failed: e.failed === true,
      }));
    });
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

/**
 * A `markWhenPresent` mark, ms from the navigation's start: `painted` once the
 * frame holding the element was painted (waited for), `dom` when it matched.
 */
async function readMark(
  page: Page,
  name: string,
): Promise<{ painted: number; dom: number }> {
  const key = (k: string): string =>
    `(window.__scaleMarks || {})[${JSON.stringify(k)}]`;
  await untilInPage(
    page,
    `${key(name)} !== undefined`,
    STEP_TIMEOUT_MS,
    `the frame showing ${name} to be painted`,
  );
  return page.evaluate<{ painted: number; dom: number }>(
    `({ painted: ${key(name)}, dom: ${key(`${name}:dom`)} })`,
  );
}

/** A `readMark` reading: ms from the navigation's start. */
interface Mark {
  painted: number;
  dom: number;
}

/**
 * The note of a first-paint budget timed over cold navigations (Ruling R46):
 * how it was sampled, then the spread of the painted times and the p95 to the
 * element entering the DOM.
 */
function coldNote(marks: readonly Mark[], unsettled: number): string {
  const painted = p95Of(marks.map((m) => m.painted));
  const dom = p95Of(marks.map((m) => m.dom));
  const late =
    unsettled > 0
      ? `; ${unsettled} navigation${unsettled === 1 ? " was" : "s were"} still loading ${QUIET_CAP_MS / 1000} s on, when the next began`
      : "";
  return `p95 over ${painted.samples} cold navigations, each in a new context (cold HTTP cache, signed in), after 1 untimed warm-up navigation of the route; median ${round(painted.median)} ms, slowest ${round(painted.max)} ms; to the element entering the DOM, p95 ${round(dom.p95)} ms${late}`;
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

/**
 * Armed before a timed key press: `window.__scaleKeyAt` becomes the wall
 * clock (ms since the epoch) at which the page saw the next key go down.
 */
const ARM_KEY_TIME = `(() => {
  window.__scaleKeyAt = null;
  window.addEventListener(
    "keydown",
    () => {
      if (window.__scaleKeyAt === null) {
        window.__scaleKeyAt = performance.timeOrigin + performance.now();
      }
    },
    { capture: true, once: true },
  );
})()`;

/**
 * The note of a list-refetch count (Ruling R42): the list query requested most
 * in one window (sliding, Ruling R41), and how many list calls there were.
 */
function busiestNote(lists: readonly LoggedCall[], windowMs: number): string {
  const busiest = busiestQuery(lists, windowMs);
  const which =
    busiest === null
      ? "none"
      : `${queryLabel(busiest.path, busiest.input)} ×${busiest.count}`;
  return `${which} (any ${windowMs / 1000} s window; the lists are ${LIST_PROCEDURES.join(", ")}, each query by path and input); ${lists.length} list-query calls in all`;
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
  let rows = 0;
  let unsettled = 0;
  const marks = await warmThenTime(s.navigations, ({ warmUp, index }) =>
    withPage(s, [markWhenPresent("row", BATCH_ROW)], async (page, log) => {
      await page.goto(`${s.origin}/inbox`, { waitUntil: "commit" });
      await page.waitForSelector(BATCH_ROW, { state: "visible" });
      const mark = await readMark(page, "row");
      if (!warmUp && index === 0) rows = await page.locator(BATCH_ROW).count();
      // What this page still loads must not overlap the next navigation.
      if (!(await log.quiet())) unsettled += 1;
      return mark;
    }),
  );
  const t = p95Of(marks.map((m) => m.painted));
  return [
    {
      id: "D1",
      value: round(t.p95),
      samples: t.samples,
      note: `/inbox at its default view, to the first batch row painted: ${coldNote(marks, unsettled)}; ${rows} batch rows by then (first timed navigation)`,
    },
  ];
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
  const url = `${s.origin}/projects/${projectId}/builds/${newestBuildId}`;
  const marks: Mark[] = [];
  let counted: Counted | undefined;
  let unsettled = 0;
  try {
    await warmThenTime(s.navigations, ({ warmUp, index }) =>
      withPage(s, [markWhenPresent("row", RUN_ROW)], async (page, log) => {
        await page.goto(url, { waitUntil: "commit" });
        await page.waitForSelector(RUN_ROW, { state: "visible" });
        const mark = await readMark(page, "row");
        if (!warmUp) marks.push(mark);
        // The counts come from the first timed navigation, which also lets
        // the page settle; every other one only settles, so what it still
        // loads does not overlap the next navigation.
        if (!warmUp && index === 0) counted = await countBatch(s, page, log);
        else if (!(await log.quiet())) unsettled += 1;
      }),
    );
  } catch (error) {
    if (error instanceof InterruptedError || s.stack.teardown.closing) {
      throw error;
    }
    // A later navigation failing loses only the first-row timing.
    if (counted === undefined) throw error;
    return [
      ...counted.measurements,
      {
        id: "D2.firstRow",
        value: null,
        error: `timed navigation ${marks.length + 1} of ${s.navigations} failed: ${brief(error)}`,
      },
    ];
  }
  if (counted === undefined) throw new Error("D2's counts were not taken");
  const t = p95Of(marks.map((m) => m.painted));
  return [
    {
      id: "D2.firstRow",
      value: round(t.p95),
      samples: t.samples,
      note: `${counted.where}; to the first run row painted: ${coldNote(marks, unsettled)}`,
    },
    ...counted.measurements,
  ];
}

/** D2's counts, from one page that has just shown its first run row. */
interface Counted {
  /** What the page showed, for the notes. */
  where: string;
  /** D2.domMax, D2.offscreenImages and D2.imageKB. */
  measurements: Measurement[];
}

/**
 * D2's counts on a batch page whose first run row is up: the DOM size at the
 * top (once the page has loaded what it loads on its own), the middle and the
 * bottom of the list, the step images fetched for cards outside the viewport
 * at the top, and the largest step image.
 */
async function countBatch(
  s: Session,
  page: Page,
  log: NetworkLog,
): Promise<Counted> {
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
  const first = "on the first timed navigation";
  return {
    where: `the newest batch at its default view (Needs review): ${runs} run rows, ${cards} step cards`,
    measurements: [
      {
        id: "D2.domMax",
        value: Math.max(...counts),
        note: `${first}: top ${counts[0]}, middle ${counts[1]} (${positions[0]}), bottom ${counts[2]} (${positions[1]}) elements${settled ? "" : `; the page was still loading after ${QUIET_CAP_MS / 1000} s`}`,
      },
      {
        id: "D2.offscreenImages",
        value: offscreen,
        note: `${first}: ${topRequests.length} step-image requests by the time the top had loaded, ${visible.length} cards in the viewport there (each card's image key read from screenshots.image_key by its step-card id)`,
      },
      sizes.length === 0
        ? {
            id: "D2.imageKB",
            value: null,
            note: `${first}: no step image came over the network`,
          }
        : {
            id: "D2.imageKB",
            value: round((sizes[sizes.length - 1] as number) / 1024),
            samples: sizes.length,
            note: `${first}: largest of ${sizes.length} step images fetched (top, middle and bottom), body bytes on the wire; median ${round(percentile(sizes, 50) / 1024)} KB`,
          },
    ],
  };
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
  const s = (window.__scaleStep = {
    keyAt: null,
    drawnAt: null,
    paintedAt: null,
    id: null,
  });
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
      // For the note: when the frame showing it had been painted.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          s.paintedAt = performance.now();
        }),
      );
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
): Promise<{ measurements: Measurement[]; calls?: string[] }> {
  const { projectId, longRunId, longRunFirstStepId } = s.seeded;
  const [row] = await s.stack.db
    .select({ n: count() })
    .from(screenshots)
    .where(eq(screenshots.runId, longRunId));
  const steps = Number(row?.n ?? 0);
  const plan = walkPlan(steps, D5_WARMUPS + D5_MOVES);
  const drawnFirst = `[data-stage-drawn="${longRunFirstStepId}"]`;
  const url = `${s.origin}/projects/${projectId}/runs/${longRunId}/checkpoints/${longRunFirstStepId}`;

  const marks: Mark[] = [];
  let calls: string[] | undefined;
  let next: Measurement | undefined;
  let unsettled = 0;
  let failure: unknown;
  try {
    await warmThenTime(s.navigations, ({ warmUp, index }) =>
      withPage(s, [markWhenPresent("drawn", drawnFirst)], async (page, log) => {
        await page.goto(url, { waitUntil: "commit" });
        await page.waitForSelector(drawnFirst, { state: "attached" });
        const mark = await readMark(page, "drawn");
        // Up to the network settling after the step was drawn: on the first
        // timed navigation that is the call set; on every one, nothing still
        // loading overlaps the next navigation.
        if (!(await log.quiet())) unsettled += 1;
        if (warmUp) return;
        marks.push(mark);
        if (index !== 0) return;
        calls = [
          ...new Set(log.entries.flatMap((e) => unpackTrpcPaths(e.url))),
        ];
        next = await measureNext(s, page, log, plan, longRunFirstStepId, steps);
      }),
    );
  } catch (error) {
    if (error instanceof InterruptedError || s.stack.teardown.closing) {
      throw error;
    }
    // A later navigation failing loses only D5.open: the call set and
    // D5.next stand.
    if (calls === undefined) throw error;
    failure = error;
  }

  const t = p95Of(marks.map((m) => m.painted));
  const opened: Measurement =
    failure === undefined
      ? {
          id: "D5.open",
          value: round(t.p95),
          samples: t.samples,
          note: `step 1 of the long run (${steps} steps), to the frame showing it painted (two animation frames after data-stage-drawn named it): ${coldNote(marks, unsettled)}; the first timed navigation's viewer requested ${calls?.length ?? 0} procedures while it opened (R4's call set)`,
        }
      : {
          id: "D5.open",
          value: null,
          error: `timed navigation ${marks.length + 1} of ${s.navigations} failed: ${brief(failure)}`,
        };
  return {
    measurements: [
      opened,
      next ?? { id: "D5.next", value: null, error: "not measured" },
    ],
    ...(calls !== undefined && { calls }),
  };
}

/**
 * D5.next on a viewer that has just opened step 1 of the long run: a failed
 * walk loses only D5.next.
 */
async function measureNext(
  s: Session,
  page: Page,
  log: NetworkLog,
  plan: readonly ("next" | "prev")[],
  from: string,
  steps: number,
): Promise<Measurement> {
  try {
    const timed = (await walk(s, page, log, plan, from)).slice(D5_WARMUPS);
    // Ruling R43: what a reviewer sees is the painted frame.
    const painted = timed.map((m) => m.painted).sort((a, b) => a - b);
    const drawn = timed.map((m) => m.drawn).sort((a, b) => a - b);
    return {
      id: "D5.next",
      value: round(percentile(painted, 95)),
      samples: painted.length,
      note: `p95 over ${painted.length} step moves after ${D5_WARMUPS} untimed ones, on the first timed navigation's viewer, with → / ← (the viewer's Next / Previous step; J is the review loop's next pending step, which leaves the run), from the page seeing the key go down to the frame showing the new step painted (two animation frames after data-stage-drawn named it); each move waits for the network to settle first (the next step's prefetch included)${steps <= D5_WARMUPS + D5_MOVES ? `; the run has ${steps} steps, so the walk turns back at its ends and revisits steps` : ""}; median ${round(percentile(painted, 50))} ms; to data-stage-drawn naming it: p95 ${round(percentile(drawn, 95))} ms, median ${round(percentile(drawn, 50))} ms`,
    };
  } catch (error) {
    if (error instanceof InterruptedError || s.stack.teardown.closing) {
      throw error;
    }
    return { id: "D5.next", value: null, error: brief(error) };
  }
}

/**
 * D5's step moves: for each, the time from the key press reaching the page to
 * the frame showing the new step painted (D5.next, Ruling R43), and to the
 * stage naming it as drawn (for the note), both on the page's clock.
 */
async function walk(
  s: Session,
  page: Page,
  log: NetworkLog,
  plan: readonly ("next" | "prev")[],
  from: string,
): Promise<{ drawn: number; painted: number }[]> {
  const samples: { drawn: number; painted: number }[] = [];
  let at = from;
  for (const move of plan) {
    s.alive();
    await page.evaluate(armStepWatch(at));
    await page.keyboard.press(move === "next" ? "ArrowRight" : "ArrowLeft");
    await untilInPage(
      page,
      "window.__scaleStep.paintedAt !== null",
      STEP_TIMEOUT_MS,
      `the next step drawn after "${move === "next" ? "→" : "←"}"`,
    );
    const step = await page.evaluate<{
      keyAt: number | null;
      drawnAt: number;
      paintedAt: number;
      id: string;
    }>("window.__scaleStep");
    if (step.keyAt === null) {
      throw new Error("a step move's key press never reached the page");
    }
    samples.push({
      drawn: step.drawnAt - step.keyAt,
      painted: step.paintedAt - step.keyAt,
    });
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

    // The window starts at the key press, on the page's wall clock, which is
    // the clock the browser stamps its requests' start with.
    await page.evaluate(ARM_KEY_TIME);
    const pressed = performance.now();
    await page.keyboard.press("a");
    await sleep(Math.max(0, pressed + D3_WINDOW_MS - performance.now()));
    // The requests' start times come with their responses.
    await log.quiet();
    const keyAt = await page.evaluate<number | null>("window.__scaleKeyAt");
    if (keyAt === null)
      throw new Error(`the "a" key press never reached the page`);
    const calls = log.trpcCalls(keyAt, keyAt + D3_WINDOW_MS);
    if (!calls.some((c) => c.path === "review.approve")) {
      throw new Error(
        `"a" on the step sent no review.approve within ${D3_WINDOW_MS / 1000} s`,
      );
    }
    const lists = listQueries(calls.filter((c) => c.method === "GET"));
    return [
      {
        id: "D3.calls",
        value: calls.length,
        note: `procedure calls the browser started in the ${D3_WINDOW_MS / 1000} s after "a" on a pending step of the newest batch (reached with ${moves} "j" presses), batches unpacked: ${tally(calls)}${unansweredNote(calls)}`,
      },
      {
        id: "D3.refetches",
        value: refetchesPerQuery(lists, D3_WINDOW_MS),
        note: `most requests of one list query in that window: ${busiestNote(lists, D3_WINDOW_MS)}`,
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
      // The same instant on the wall clock the browser stamps requests with.
      const t0Wall = Date.now();
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
      // The requests' start times come with their responses.
      await log.quiet();
      const queries = log
        .trpcCalls(t0Wall, t0Wall + (end - t0))
        .filter((c) => c.method === "GET");
      const lists = listQueries(queries);
      const secs = (ms: number): string => `${round(ms / 1000)} s`;
      return {
        id: "D4",
        value: refetchesPerQuery(lists, D4_WINDOW_MS),
        samples: lists.length,
        note: `most requests of one list query in a ${D4_WINDOW_MS / 1000} s window: ${busiestNote(lists, D4_WINDOW_MS)}; over ${secs(end - t0)} of a batch tab (status All) while a ${total}-step run uploaded (${uploaded} uploads${uploadsEnded === undefined ? `, cut at ${secs(D4_RECORD_MS)}` : ` in ${secs(uploadsEnded - t0)}`}) and diffed${idleAt === undefined ? "" : ` (queue idle after ${secs(idleAt - t0)})`}; all queries: ${tally(queries)}${unansweredNote(queries)}`,
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
