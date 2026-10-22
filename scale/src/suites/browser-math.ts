import { createHash } from "node:crypto";

import type { ShapeName } from "../seed/shape.js";
import { percentile } from "../stats.js";

/**
 * The browser suite's pure parts (spec §5.4): reading the dashboard's network
 * log (tRPC procedure calls, storage-proxy image fetches) and counting it.
 */

/** One procedure call of a tRPC request: its path and its input as sent. */
export interface TrpcCall {
  path: string;
  /** The call's input as JSON text, `""` when it has none (or it is unreadable). */
  input: string;
}

/** Where the tRPC procedure paths start in a request's path. */
const TRPC_PREFIX = "/trpc/";

const pathnameOf = (url: string): { pathname: string; search: string } => {
  const u = new URL(url, "http://localhost");
  return { pathname: u.pathname, search: u.search };
};

/**
 * The procedure paths of one tRPC request, in order. A batched request
 * (`/api/trpc/a,b,c?batch=1&input=…`) names several; `[]` for a URL that is not
 * a tRPC call.
 */
export function unpackTrpcPaths(url: string): string[] {
  const { pathname } = pathnameOf(url);
  const at = pathname.indexOf(TRPC_PREFIX);
  if (at === -1) return [];
  return decodeURIComponent(pathname.slice(at + TRPC_PREFIX.length))
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * The calls of one tRPC request, each with its own input: a batched GET sends
 * its inputs as one JSON object keyed by position (`{"0": …, "1": …}`). An
 * input that cannot be read leaves the paths, with empty inputs. A POST
 * (a mutation) carries its input in the body, so its calls have none here.
 */
export function unpackTrpcCalls(url: string): TrpcCall[] {
  const paths = unpackTrpcPaths(url);
  if (paths.length === 0) return [];
  const params = new URLSearchParams(pathnameOf(url).search);
  const raw = params.get("input");
  let inputs: (string | undefined)[] = [];
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (params.get("batch") === "1") {
        const byIndex =
          parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {};
        inputs = paths.map((_, i) => {
          const one = byIndex[String(i)];
          return one === undefined ? undefined : JSON.stringify(one);
        });
      } else {
        inputs = [JSON.stringify(parsed)];
      }
    } catch {
      inputs = [];
    }
  }
  return paths.map((path, i) => ({ path, input: inputs[i] ?? "" }));
}

/** A query's calls, told apart by path and input (a query key, as React Query keys them). */
interface QueryCall {
  path: string;
  input?: string;
  t: number;
}

/**
 * The most calls of `times` inside any window of `windowMs` (Ruling R41): a
 * sliding window, half-open (`[t, t + windowMs)`), so two calls exactly a
 * window apart are in different windows. Two pointers over the sorted times.
 */
function mostInAnyWindow(times: readonly number[], windowMs: number): number {
  if (!(windowMs > 0)) {
    throw new RangeError(`windowMs must be positive, got ${windowMs}`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  let most = 0;
  let from = 0;
  for (let to = 0; to < sorted.length; to += 1) {
    while ((sorted[to] as number) - (sorted[from] as number) >= windowMs) {
      from += 1;
    }
    most = Math.max(most, to - from + 1);
  }
  return most;
}

/**
 * The query requested most often inside one window, and how often; null with
 * no calls. Ties go to the query first seen.
 */
export function busiestQuery(
  calls: readonly QueryCall[],
  windowMs: number,
): { count: number; path: string; input: string } | null {
  const byQuery = new Map<
    string,
    { path: string; input: string; times: number[] }
  >();
  for (const call of calls) {
    const input = call.input ?? "";
    const key = `${call.path}\u0000${input}`;
    const query = byQuery.get(key);
    if (query === undefined) {
      byQuery.set(key, { path: call.path, input, times: [call.t] });
    } else {
      query.times.push(call.t);
    }
  }
  let best: { count: number; path: string; input: string } | null = null;
  for (const { path, input, times } of byQuery.values()) {
    const count = mostInAnyWindow(times, windowMs);
    if (best === null || count > best.count) best = { count, path, input };
  }
  return best;
}

/** The most times one query was requested inside any one window; 0 with no calls. */
export function refetchesPerQuery(
  calls: readonly QueryCall[],
  windowMs: number,
): number {
  return busiestQuery(calls, windowMs)?.count ?? 0;
}

/** The procedures that load a list the batch page shows (Ruling R42). */
export const LIST_PROCEDURES: readonly string[] = [
  "runs.list",
  "runs.listCheckpoints",
  "builds.list",
];

/** The calls of `calls` that load a list (D3.refetches, D4). */
export function listQueries<T extends { path: string }>(
  calls: readonly T[],
): T[] {
  return calls.filter((c) => LIST_PROCEDURES.includes(c.path));
}

/**
 * A query for a note: its procedure, its input's field names and a short
 * digest of the input, so two queries of one procedure read differently
 * without any id in the text (`runs.listCheckpoints(runId) #3f2a1c`).
 */
export function queryLabel(path: string, input: string): string {
  if (input === "") return `${path}()`;
  let fields = "";
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed !== null && typeof parsed === "object") {
      fields = Object.keys(parsed).join(",");
    }
  } catch {
    // An unreadable input is still told apart by its digest.
  }
  const digest = createHash("sha1").update(input).digest("hex").slice(0, 6);
  return `${path}(${fields}) #${digest}`;
}

/** The storage-proxy route's last segments: `…/v1/storage/<key>`. */
const STORAGE_PATH = /\/v1\/storage\/([^/]+)$/;

/** The object key a storage-proxy request fetches, or null for any other URL. */
export function storageKeyOf(url: string): string | null {
  const match = STORAGE_PATH.exec(pathnameOf(url).pathname);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

/**
 * Step images fetched for cards outside the viewport: the storage requests
 * left over once each visible card has accounted for one fetch of its key.
 * Keys are content-addressed, so two cards can show the same image: pass one
 * key per visible card (a `Set` lets each key account for one fetch). A
 * request that is not a step image is ignored.
 */
export function offscreenImages(
  requests: readonly { url: string }[],
  visibleKeys: Iterable<string>,
): number {
  const left = new Map<string, number>();
  for (const key of visibleKeys) left.set(key, (left.get(key) ?? 0) + 1);
  let offscreen = 0;
  for (const request of requests) {
    const key = storageKeyOf(request.url);
    if (key === null) continue;
    const n = left.get(key) ?? 0;
    if (n > 0) left.set(key, n - 1);
    else offscreen += 1;
  }
  return offscreen;
}

/**
 * Ruling R46: how many timed cold navigations D1, D2.firstRow and D5.open
 * each take. Spec §2.1 asks for a p95 over at least 50 samples; `smoke` only
 * checks that the harness works, so it takes fewer.
 */
export const COLD_NAVIGATIONS: Readonly<Record<ShapeName, number>> = {
  large: 50,
  smoke: 10,
};

/** One navigation of a `warmThenTime` series. */
export interface Navigation {
  /** The untimed one that comes first; its result is dropped. */
  warmUp: boolean;
  /** 0 to n-1 for the timed ones, in order; -1 for the warm-up. */
  index: number;
}

/**
 * Ruling R46: one untimed warm-up navigation of a route, then `n` timed ones,
 * run one after the other by `navigate` (each a fresh page). Returns the
 * timed results in order. The warm-up's is dropped: it pays the dashboard
 * server's first request for the route, a cost a long-running server never
 * pays. A navigation that throws ends the series and rejects with its error.
 */
export async function warmThenTime<T>(
  n: number,
  navigate: (nav: Navigation) => Promise<T>,
): Promise<T[]> {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(
      `timed navigations must be a positive integer, got ${n}`,
    );
  }
  await navigate({ warmUp: true, index: -1 });
  const timed: T[] = [];
  for (let index = 0; index < n; index += 1) {
    timed.push(await navigate({ warmUp: false, index }));
  }
  return timed;
}

/** The nearest-rank p95 of `values` (in any order), with the median, slowest and count. */
export function p95Of(values: readonly number[]): {
  p95: number;
  median: number;
  max: number;
  samples: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p95: percentile(sorted, 95),
    median: percentile(sorted, 50),
    max: percentile(sorted, 100),
    samples: sorted.length,
  };
}

/**
 * D5's walk through a run of `steps` steps from its first: `moves` step
 * moves, forward until the last step, then back until the first, and so on,
 * so every move lands on a step of the run.
 */
export function walkPlan(steps: number, moves: number): ("next" | "prev")[] {
  if (steps < 2) {
    throw new Error(`the viewer walk needs a run of at least 2 steps`);
  }
  const plan: ("next" | "prev")[] = [];
  let at = 0;
  let forward = true;
  for (let i = 0; i < moves; i += 1) {
    if (forward && at === steps - 1) forward = false;
    else if (!forward && at === 0) forward = true;
    plan.push(forward ? "next" : "prev");
    at += forward ? 1 : -1;
  }
  return plan;
}

/** A segment that names one row or object: a UUID, a long hex key, a number. */
const ID_SEGMENT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;
const KEY_SEGMENT = /^[0-9a-f]{32,}$/i;

/**
 * A URL's path with every id or key replaced by its kind (`:id`, `:key`), and
 * no origin or query: what a failure sample may say about a request.
 */
export function routeShape(url: string): string {
  return pathnameOf(url)
    .pathname.split("/")
    .map((segment) =>
      KEY_SEGMENT.test(segment)
        ? ":key"
        : ID_SEGMENT.test(segment)
          ? ":id"
          : segment,
    )
    .join("/");
}

/** Responses R8 counts as refused for their size: body, URL, headers. */
const SIZE_REFUSALS: readonly number[] = [413, 414, 431];
/** Chromium's error for a request the browser side cancelled itself. */
const ABORTED = "net::ERR_ABORTED";
/** Failure samples kept for the note. */
const SAMPLE_SIZE = 5;

/** A response the browser got with a failing status. */
export interface FailedResponse {
  url: string;
  status: number;
  /** The harness proxy answered it itself (its upstream did not). */
  byProxy: boolean;
}

/** A request that got no response. */
export interface FailedRequest {
  url: string;
  /** Chromium's error text (`net::ERR_…`). */
  errorText: string;
  /** It failed after the suite began closing its browser context. */
  closing: boolean;
}

export interface BrowserFailureCount {
  /** What R8 adds for the browser suite. */
  count: number;
  /** 5xx the api answered: its own HTTP histogram already counts them. */
  inHistogram: number;
  /** Cancellations, never counted: the suite's (closing a context) and the page's own. */
  aborted: { suite: number; page: number };
  /** Up to 5 counted failures, `status route` or `failed error route`. */
  sample: string[];
}

/**
 * The browser suite's share of R8 (Ruling R36), on the rule the server suite
 * uses for its own clients: what the api's HTTP histogram cannot see.
 *
 * - **Counted:** a size refusal (413, 414, 431); a request that got no
 *   response (a transport failure); a 5xx the api did not answer itself (the
 *   dashboard's, or the harness proxy's own 502, which it marks).
 * - **Not counted:** a 5xx the api answered (`/api/…`, not the proxy's), which
 *   is already in its histogram; and `net::ERR_ABORTED`, a cancellation on
 *   the browser side, never a server failure: the suite's when it happens
 *   while the suite closes the context, else the page's own (React Query
 *   cancelling a refetch, a route change).
 */
export function countBrowserFailures(
  responses: readonly FailedResponse[],
  failures: readonly FailedRequest[],
): BrowserFailureCount {
  const out: BrowserFailureCount = {
    count: 0,
    inHistogram: 0,
    aborted: { suite: 0, page: 0 },
    sample: [],
  };
  const counted = (line: string): void => {
    out.count += 1;
    if (out.sample.length < SAMPLE_SIZE) out.sample.push(line);
  };
  for (const r of responses) {
    const route = routeShape(r.url);
    if (SIZE_REFUSALS.includes(r.status)) {
      counted(`${r.status} ${route}`);
    } else if (r.status >= 500) {
      const byApi = !r.byProxy && route.startsWith("/api/");
      if (byApi) out.inHistogram += 1;
      else counted(`${r.status} ${route}`);
    }
  }
  for (const f of failures) {
    if (f.errorText === ABORTED) {
      if (f.closing) out.aborted.suite += 1;
      else out.aborted.page += 1;
    } else {
      counted(`failed ${f.errorText} ${routeShape(f.url)}`);
    }
  }
  return out;
}
