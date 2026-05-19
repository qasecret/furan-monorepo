import { Counter, Histogram, type Registry } from "@furan/telemetry";

interface RegisteredMetrics {
  total: Counter<"outcome">;
  duration: Histogram;
  propertiesCount: Histogram;
}

const metricsByRegistry = new WeakMap<Registry, RegisteredMetrics>();

function getOrRegister(registry: Registry): RegisteredMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const total = new Counter({
    name: "furan_builds_create_total",
    help: "POST /projects/:id/builds outcomes (created vs reattached)",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "furan_builds_find_or_create_duration_seconds",
    help: "Wall-clock duration of the find-or-create transaction",
    buckets: [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [registry],
  });
  const propertiesCount = new Histogram({
    name: "furan_builds_properties_count",
    help: "Number of properties on a build at create/update time",
    buckets: [0, 1, 2, 5, 10, 20],
    registers: [registry],
  });
  const out: RegisteredMetrics = { total, duration, propertiesCount };
  metricsByRegistry.set(registry, out);
  return out;
}

export function recordBuildCreate(
  registry: Registry,
  args: {
    outcome: "created" | "reattached";
    durationMs: number;
    propertiesCount: number;
  },
): void {
  const m = getOrRegister(registry);
  m.total.inc({ outcome: args.outcome });
  m.duration.observe(args.durationMs / 1000);
  m.propertiesCount.observe(args.propertiesCount);
}
