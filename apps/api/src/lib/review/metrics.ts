import type {
  CheckpointDecisionKind,
  DecisionSource,
  RevertSkipReason,
} from "@furan/shared-types";
import { Counter, Histogram, type Registry } from "@furan/telemetry";

import type { NextResult } from "./queue.js";

/** Buckets of `furan_review_next_seconds` (seconds); the p95 budget is 50 ms. */
const NEXT_SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

interface RegisteredMetrics {
  decisions: Counter<"decision" | "source">;
  reverts: Counter<"outcome">;
  revertRefused: Counter<"reason">;
  next: Counter<"scope">;
  nextSeconds: Histogram;
}

const metricsByRegistry = new WeakMap<Registry, RegisteredMetrics>();

function getOrRegister(registry: Registry): RegisteredMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const decisions = new Counter({
    name: "furan_review_decisions_total",
    help: "Per-checkpoint review decisions recorded, by decision and the surface they came from",
    labelNames: ["decision", "source"] as const,
    registers: [registry],
  });
  const reverts = new Counter({
    name: "furan_review_reverts_total",
    help: "Per-checkpoint outcomes of a review undo (reverted vs skipped)",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const revertRefused = new Counter({
    name: "furan_review_revert_refused_total",
    help: "Review undo attempts that left a decision as it was, by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const next = new Counter({
    name: "furan_review_next_total",
    help: "review.next answers, by where the next step is (run, batch, nextBatch or none)",
    labelNames: ["scope"] as const,
    registers: [registry],
  });
  const nextSeconds = new Histogram({
    name: "furan_review_next_seconds",
    help: "Time review.next took to answer, including the check of its at position",
    buckets: NEXT_SECONDS_BUCKETS,
    registers: [registry],
  });
  const out: RegisteredMetrics = {
    decisions,
    reverts,
    revertRefused,
    next,
    nextSeconds,
  };
  metricsByRegistry.set(registry, out);
  return out;
}

/**
 * A non-positive or non-finite (NaN, Infinity) count is a no-op rather than an
 * error: prom-client throws on a negative or non-finite `inc`, and a bulk path
 * that decided nothing must never fail the review action it is merely
 * observing.
 */
function isCountable(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function recordReviewDecisions(
  registry: Registry,
  decision: CheckpointDecisionKind,
  source: DecisionSource,
  n: number,
): void {
  if (!isCountable(n)) return;
  getOrRegister(registry).decisions.inc({ decision, source }, n);
}

export function recordReviewRevert(
  registry: Registry,
  outcome: "reverted" | "skipped",
  n: number,
): void {
  if (!isCountable(n)) return;
  getOrRegister(registry).reverts.inc({ outcome }, n);
}

export function recordReviewRevertRefused(
  registry: Registry,
  reason: RevertSkipReason,
): void {
  getOrRegister(registry).revertRefused.inc({ reason });
}

/**
 * One `review.next` answer: counted by its `scope`, its duration observed.
 * A duration that is negative or not finite is counted but not observed
 * (prom-client throws on a non-finite observation, and observing a read must
 * never fail it).
 */
export function recordReviewNext(
  registry: Registry,
  scope: NextResult["scope"],
  seconds: number,
): void {
  const m = getOrRegister(registry);
  m.next.inc({ scope });
  if (Number.isFinite(seconds) && seconds >= 0) m.nextSeconds.observe(seconds);
}
