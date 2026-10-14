import type {
  CheckpointDecisionKind,
  DecisionSource,
  RevertSkipReason,
} from "@furan/shared-types";
import { Counter, type Registry } from "@furan/telemetry";

interface RegisteredMetrics {
  decisions: Counter<"decision" | "source">;
  reverts: Counter<"outcome">;
  revertRefused: Counter<"reason">;
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
  const out: RegisteredMetrics = { decisions, reverts, revertRefused };
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
