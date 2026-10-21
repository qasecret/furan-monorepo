import type { Measurement } from "../budgets.js";
import { percentile } from "../stats.js";

/**
 * Pure helpers of the server suite (spec §5.3): slicing the review work among
 * the reviewers, and turning call samples into measurements.
 */

/** One HTTP call of the server suite. */
export interface CallSample {
  /** What it measured: a procedure path, or a path and a variant. */
  key: string;
  /** Client wall time. */
  ms: number;
  /** HTTP status; 0 when no response came back (a transport failure). */
  status: number;
  /** Decoded response body length. */
  bytes: number;
}

/** Statuses that refuse a request for its size (R8): body, URL, headers. */
export const SIZE_STATUSES: readonly number[] = [413, 414, 431];

const isOk = (status: number): boolean => status >= 200 && status < 300;

/**
 * A failure R8 counts rather than the budget: a 5xx, a size refusal or no
 * response at all. Any other non-2xx means the api refused what the harness
 * sent, so the timing would not be of the real path.
 */
const isLoadFailure = (status: number): boolean =>
  status === 0 || status >= 500 || SIZE_STATUSES.includes(status);

/**
 * `items` in order, cut into `n` contiguous slices whose sizes differ by at
 * most one (the earlier ones larger). Together they hold every item once, so
 * reviewers given different slices never decide the same step.
 */
export function disjointSlices<T>(items: readonly T[], n: number): T[][] {
  if (!(Number.isInteger(n) && n >= 1)) {
    throw new RangeError(`slice count must be a positive integer, got ${n}`);
  }
  const base = Math.floor(items.length / n);
  const extra = items.length % n;
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * Ruling R27: R7 may approve at most half of the review batch's pending steps
 * (rounded down), the first half in capture order. The rest is a reserve that
 * is never approved, so the batch stays pending for the whole window.
 */
export function splitReserve<T>(pending: readonly T[]): {
  approvable: T[];
  reserve: T[];
} {
  const half = Math.floor(pending.length / 2);
  return {
    approvable: pending.slice(0, half),
    reserve: pending.slice(half),
  };
}

/**
 * Ruling R27: a reviewer that has approved `done` of its `sliceLength` steps
 * may approve another only while `done < sliceLength × elapsed / window`, so
 * its slice is spread evenly over the window, never front-loaded, and never
 * overrun.
 */
export function mayApprove(
  done: number,
  sliceLength: number,
  elapsedMs: number,
  windowMs: number,
): boolean {
  return done < sliceLength && done < (sliceLength * elapsedMs) / windowMs;
}

function statusList(samples: readonly CallSample[]): string {
  const counts = new Map<number, number>();
  for (const s of samples)
    counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a - b)
    .map(([status, n]) => `${n}× ${status === 0 ? "no response" : status}`)
    .join(", ");
}

/**
 * Budget `id` from the samples under `keys`: the nearest-rank p95 of the calls
 * that succeeded. Load failures (5xx, size refusals, no response) are left out
 * of the timing and noted; R8 counts them. Any other refusal marks the budget
 * `error`: the harness sent something the api would not take.
 */
export function measureCalls(
  id: string,
  samples: readonly CallSample[],
  keys: readonly string[],
): Measurement {
  const mine = samples.filter((s) => keys.includes(s.key));
  if (mine.length === 0) {
    return { id, value: null, note: `no calls of ${keys.join(" + ")}` };
  }
  const ok = mine
    .filter((s) => isOk(s.status))
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  const loadFailed = mine.filter((s) => isLoadFailure(s.status));
  const refused = mine.filter(
    (s) => !isOk(s.status) && !isLoadFailure(s.status),
  );
  const note = [
    `p95 over ${ok.length} calls of ${keys.join(" + ")}`,
    ...(loadFailed.length > 0
      ? [`${loadFailed.length} failed (${statusList(loadFailed)}; see R8)`]
      : []),
  ].join("; ");
  return {
    id,
    value: ok.length > 0 ? percentile(ok, 95) : null,
    samples: ok.length,
    note,
    ...(refused.length > 0
      ? {
          error: `${refused.length} of ${mine.length} calls were refused (${statusList(refused)})`,
        }
      : {}),
  };
}

/**
 * R8: the api's 5xx responses (from its HTTP histogram) plus what the clients
 * saw that the histogram cannot: size refusals (a 431 never reaches a route)
 * and calls that got no response. A client's 5xx is already in the histogram.
 */
export function failedRequests(
  serverErrors: number,
  samples: readonly { status: number }[],
): { value: number; note: string } {
  const size = samples.filter((s) => SIZE_STATUSES.includes(s.status)).length;
  const transport = samples.filter((s) => s.status === 0).length;
  return {
    value: serverErrors + size + transport,
    note: `${serverErrors} 5xx in the api's HTTP histogram, ${size} size refusals (413/414/431) and ${transport} transport failures seen by the clients`,
  };
}

/**
 * R6: the p95 of the storage proxy's server-side time minus the p95 of the
 * object download on its own, never below zero.
 */
export function serverMinusStorage(
  serverMs: readonly number[],
  storageMs: readonly number[],
): { value: number; serverP95: number; storageP95: number } {
  const serverP95 = percentile(
    [...serverMs].sort((a, b) => a - b),
    95,
  );
  const storageP95 = percentile(
    [...storageMs].sort((a, b) => a - b),
    95,
  );
  return { value: Math.max(0, serverP95 - storageP95), serverP95, storageP95 };
}
