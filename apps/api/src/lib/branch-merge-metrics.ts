import { Counter, Histogram, type Registry } from "@furan/telemetry";

interface RegisteredMetrics {
  total: Counter<"outcome">;
  duration: Histogram;
}

const metricsByRegistry = new WeakMap<Registry, RegisteredMetrics>();

function getOrRegister(registry: Registry): RegisteredMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const total = new Counter({
    name: "furan_branch_merge_total",
    help: "Per-variation outcomes for projects.mergeBranchBaselines (enqueued vs skipped)",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "furan_branch_merge_duration_seconds",
    help: "Wall-clock duration of a mergeBranchBaselines call",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });
  const out: RegisteredMetrics = { total, duration };
  metricsByRegistry.set(registry, out);
  return out;
}

export function recordBranchMergeOutcome(
  registry: Registry,
  outcome: "enqueued" | "skipped",
): void {
  getOrRegister(registry).total.inc({ outcome });
}

export function recordBranchMergeDuration(
  registry: Registry,
  durationMs: number,
): void {
  getOrRegister(registry).duration.observe(durationMs / 1000);
}
