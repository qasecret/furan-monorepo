/**
 * The review context and its URL form (spec §3.3). Pure and server-safe: no
 * React, no `next/navigation`, so a server component can `parseReviewContext`
 * its `searchParams`. The hook lives in `use-review-context.ts`; import both
 * through `@/lib/review-url`.
 *
 * The context is what a reviewer is looking at: a status chip, the
 * environment facets, and (on the Batches page only) a branch, a search and a
 * properties filter. It lives in the URL, never in component state, so a link
 * carries it from Batches to a batch to the viewer and back.
 *
 * Rules (§3.3): defaults are omitted from the URL; bad input is dropped
 * silently and never errors the page. Every value is validated here, on the
 * way in and on the way out, to the limits the API enforces, so what we write
 * is always something we (and the API) accept.
 */
import { buildPropertiesSchema } from "@furan/shared-types";
import type { RunStatus } from "@furan/shared-types";
import { z } from "zod";

import type { RouterInputs } from "@/lib/trpc";

export const REVIEW_STATUSES = [
  "needs-review",
  "failed",
  "running",
  "passed",
  "all",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** The default chip. Omitted from the URL: a clean URL is Needs review. */
export const DEFAULT_REVIEW_STATUS: ReviewStatus = "needs-review";

/**
 * The environment facets `review.next` and `runs.list` filter by. Derived from
 * the API's input so it cannot drift from it.
 */
export type StepFacets = NonNullable<RouterInputs["review"]["next"]["facets"]>;

export interface ReviewContext {
  status: ReviewStatus;
  facets: StepFacets;
  /** Batches page only: an exact branch name. */
  branch?: string;
  /** Batches page only: the search text. */
  q?: string;
  /** The builds panel's properties filter. */
  props?: Record<string, string>;
}

const FACET_KEYS = ["browser", "viewport", "os", "device"] as const;
type FacetKey = (typeof FACET_KEYS)[number];

/** Facet lengths follow the API (`review.next` / `runs.list`: spec §4.2). */
const FACET_SCHEMAS: Record<FacetKey, z.ZodString> = {
  browser: z.string().min(1).max(64),
  viewport: z.string().min(1).max(32),
  os: z.string().min(1).max(64),
  device: z.string().min(1).max(64),
};
const statusSchema = z.enum(REVIEW_STATUSES);
/** `builds.list` takes a branch of 1..200; the search text gets the same bound. */
const textSchema = z.string().min(1).max(200);

/** The `props` cap. `buildPropertiesSchema` allows 1..20 properties per build. */
const MAX_PROPS = 20;

/** Every search param the context owns (for a writer that must leave the rest alone). */
export const REVIEW_PARAM_NAMES = [
  "status",
  ...FACET_KEYS,
  "branch",
  "q",
  "props",
] as const;

const ALL_KEYS: ReadonlyArray<keyof ReviewContext> = [
  "status",
  "facets",
  "branch",
  "q",
  "props",
];

/** What travels along the loop: batch and viewer links carry these two. */
const LOOP_KEYS: ReadonlyArray<keyof ReviewContext> = ["status", "facets"];

/**
 * What a link in the builds panel carries: the loop keys, plus `props` (the
 * panel's own filter, which stays on the URL beside every batch page).
 */
export const PANEL_LINK_KEYS = [...LOOP_KEYS, "props"] as const;

// ---------- normalization ----------

function cleanFacets(raw: unknown): StepFacets {
  const out: StepFacets = {};
  if (typeof raw !== "object" || raw === null) return out;
  const src = raw as Record<string, unknown>;
  for (const k of FACET_KEYS) {
    const parsed = FACET_SCHEMAS[k].safeParse(src[k]);
    if (parsed.success) out[k] = parsed.data;
  }
  return out;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The valid entries of a properties filter, sorted by key (so the same filter
 * always serializes the same) and capped at the API's 20. An entry is valid
 * when `buildPropertiesSchema` accepts it: key 1..64 of `[A-Za-z0-9_.-]`,
 * value up to 256.
 */
function cleanProps(
  raw: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const entries = Object.entries(raw)
    .filter(
      ([k, v]) =>
        typeof v === "string" &&
        buildPropertiesSchema.safeParse({ [k]: v }).success,
    )
    .sort(([a], [b]) => compareKeys(a, b))
    .slice(0, MAX_PROPS);
  // `fromEntries` defines own properties, so a key like `__proto__` stays data.
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The canonical form of a (possibly partial, possibly bad) context. */
function normalize(ctx: Partial<ReviewContext>): ReviewContext {
  const status = statusSchema.safeParse(ctx.status);
  const branch = textSchema.safeParse(ctx.branch);
  const q = textSchema.safeParse(ctx.q);
  const props = cleanProps(ctx.props);
  return {
    status: status.success ? status.data : DEFAULT_REVIEW_STATUS,
    facets: cleanFacets(ctx.facets),
    ...(branch.success ? { branch: branch.data } : {}),
    ...(q.success ? { q: q.data } : {}),
    ...(props ? { props } : {}),
  };
}

// ---------- props encoding ----------
//
// The properties filter is one param: `props=key:value,key2:value2`.
//   * entries are sorted by key, so the encoding is stable;
//   * each key and value is `encodeURIComponent`ed, which escapes `:` and `,`,
//     so the first `:` and every `,` in the param are separators and nothing
//     else (reversible for any value);
//   * the whole param is then percent-encoded once more by URLSearchParams.
// An entry that fails to decode, has no `:` or an empty key, or exceeds the
// API's limits is dropped.

/**
 * `encodeURIComponent` throws a `URIError` on a lone surrogate, which a value
 * the API accepts may contain; the write side must never throw, so each side
 * is made well-formed first (a lone surrogate becomes U+FFFD).
 *
 * `String.prototype.toWellFormed` needs Chrome 111, Safari 16.4 or Firefox
 * 119; without it, the same result by hand. A valid surrogate pair (an emoji)
 * is matched first and kept, so only the lone halves are replaced. No
 * lookbehind: older Safari fails to parse a regex that has one.
 */
const LONE_OR_PAIRED_SURROGATE =
  /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

function toWellFormed(s: string): string {
  return typeof s.toWellFormed === "function"
    ? s.toWellFormed()
    : s.replace(LONE_OR_PAIRED_SURROGATE, (m) =>
        m.length === 2 ? m : "\uFFFD",
      );
}

const encodePart = (s: string): string => encodeURIComponent(toWellFormed(s));

function encodeProps(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([k, v]) => `${encodePart(k)}:${encodePart(v)}`)
    .join(",");
}

function decodeProps(raw: string): Record<string, string> | undefined {
  const seen = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const at = entry.indexOf(":");
    if (at < 1) continue; // no separator, or an empty key
    try {
      const key = decodeURIComponent(entry.slice(0, at));
      const value = decodeURIComponent(entry.slice(at + 1));
      if (!seen.has(key)) seen.set(key, value);
    } catch {
      // A bad escape: drop the entry, never throw.
    }
  }
  return cleanProps(Object.fromEntries(seen));
}

// ---------- parse ----------

type ParamSource =
  URLSearchParams | Record<string, string | string[] | undefined>;

function readParam(sp: ParamSource, name: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(name) ?? undefined;
  const v = sp[name];
  return Array.isArray(v) ? v[0] : v;
}

function parseStatus(raw: string | undefined): ReviewStatus | undefined {
  const parsed = statusSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read the context from search params (a `URLSearchParams`, or the record Next
 * hands a page as `searchParams`). Anything unknown or invalid is dropped;
 * this never throws. A repeated param counts once, by its first value.
 */
export function parseReviewContext(sp: ParamSource): ReviewContext {
  const facets: Record<string, string> = {};
  for (const k of FACET_KEYS) {
    const v = readParam(sp, k);
    if (v !== undefined) facets[k] = v;
  }
  const props = readParam(sp, "props");
  return normalize({
    status: parseStatus(readParam(sp, "status")),
    facets,
    branch: readParam(sp, "branch"),
    q: readParam(sp, "q"),
    props: props === undefined ? undefined : decodeProps(props),
  });
}

// ---------- serialize ----------

/**
 * The context as search params, in a fixed order, with defaults, empty and
 * invalid values omitted. `keys` limits what is written (default: all);
 * `"facets"` stands for the four facet params.
 */
export function reviewContextParams(
  ctx: Partial<ReviewContext>,
  keys: ReadonlyArray<keyof ReviewContext> = ALL_KEYS,
): URLSearchParams {
  const c = normalize(ctx);
  const out = new URLSearchParams();
  if (keys.includes("status") && c.status !== DEFAULT_REVIEW_STATUS) {
    out.set("status", c.status);
  }
  if (keys.includes("facets")) {
    for (const k of FACET_KEYS) {
      const v = c.facets[k];
      if (v !== undefined) out.set(k, v);
    }
  }
  if (keys.includes("branch") && c.branch !== undefined) {
    out.set("branch", c.branch);
  }
  if (keys.includes("q") && c.q !== undefined) out.set("q", c.q);
  if (keys.includes("props") && c.props !== undefined) {
    out.set("props", encodeProps(c.props));
  }
  return out;
}

/**
 * The context as a query string: `""` when there is nothing to write, else
 * `"?..."`. A context that parses back to itself.
 */
export function serializeReviewContext(
  ctx: Partial<ReviewContext>,
  keys?: ReadonlyArray<keyof ReviewContext>,
): string {
  const qs = reviewContextParams(ctx, keys).toString();
  return qs ? `?${qs}` : "";
}

// ---------- API filters ----------

/**
 * The run statuses each chip stands for on a batch's run list (spec §3.1: the
 * Failed / Running / Passed chips are the rollup status of the same name).
 * `passed` is only `passed`: a run that rolls up to `new` still has an
 * undecided step, so it belongs under Needs review, not under Passed.
 */
const RUN_STATUS_BY_CHIP: Record<"failed" | "running" | "passed", RunStatus[]> =
  {
    failed: ["failed"],
    running: ["running"],
    passed: ["passed"],
  };

/**
 * The `runs.list` filter for a context. Needs review is the server's pending
 * rule (§3.1), not a run status; the other chips are run statuses. Only the
 * keys the context sets are present.
 */
export function toRunsListFilter(
  ctx: ReviewContext,
): Pick<
  RouterInputs["runs"]["list"],
  "status" | "pending" | "browser" | "viewport" | "os" | "device"
> {
  const c = normalize(ctx);
  return {
    ...(c.status === "needs-review" ? { pending: true } : {}),
    ...(c.status === "failed" || c.status === "running" || c.status === "passed"
      ? { status: RUN_STATUS_BY_CHIP[c.status] }
      : {}),
    ...c.facets,
  };
}

/**
 * The `builds.list` filter for a context. On Batches the chips are filters,
 * not a partition (§3.1): a batch can be under Needs review and Failed at
 * once. Needs review is `needsReview` (a pending step) and Failed is
 * `anyFailed` (at least one failed test); Running is the batch's rollup
 * status of the same name. Passed is the `passed` rollup AND no pending step
 * (`noPending`, Ruling R32): a first-baseline batch is all `new`, which rolls
 * up to passed while every step still needs review. Facets, search and props
 * are not part of it: search is applied by the caller, and facets are
 * per-batch.
 */
export function toBuildsListFilter(
  ctx: ReviewContext,
): Pick<
  RouterInputs["builds"]["list"],
  "status" | "needsReview" | "noPending" | "anyFailed" | "branch"
> {
  const c = normalize(ctx);
  return {
    ...(c.status === "needs-review" ? { needsReview: true } : {}),
    ...(c.status === "failed" ? { anyFailed: true } : {}),
    ...(c.status === "running" ? { status: "running" } : {}),
    ...(c.status === "passed" ? { status: "passed", noPending: true } : {}),
    ...(c.branch !== undefined ? { branch: c.branch } : {}),
  };
}

// ---------- links ----------

/**
 * The batch page for a build, optionally anchored on one of its runs. Carries
 * the status and facets (the context that travels the loop, §3.3); branch,
 * search and props belong to Batches and are not carried.
 *
 * `keep` names the context keys the link carries instead of that default. The
 * builds panel sits beside every batch page, so it also keeps `props` (its
 * filter) on each link.
 */
export function batchHref(
  projectId: string,
  buildId: string,
  ctx?: Partial<ReviewContext>,
  runId?: string,
  keep?: ReadonlyArray<keyof ReviewContext>,
): string {
  const anchor = runId ? `#run-${encodeURIComponent(runId)}` : "";
  return `/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}${loopQuery(ctx, keep)}${anchor}`;
}

/**
 * The query a batch or viewer link carries: the status and facets, or the
 * `keep` keys when a link needs more.
 */
export function loopQuery(
  ctx?: Partial<ReviewContext>,
  keep: ReadonlyArray<keyof ReviewContext> = LOOP_KEYS,
): string {
  return ctx ? serializeReviewContext(ctx, keep) : "";
}
