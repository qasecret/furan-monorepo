import { Counter, type Registry } from "@furan/telemetry";

interface RegisteredMetrics {
  elementMap: Counter<"outcome">;
}

const metricsByRegistry = new WeakMap<Registry, RegisteredMetrics>();

function getOrRegister(registry: Registry): RegisteredMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const elementMap = new Counter({
    name: "furan_screenshot_element_map_uploaded_total",
    help: "Per-element bbox map sidecar uploads attached to /runs/:runId/screenshots",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const out: RegisteredMetrics = { elementMap };
  metricsByRegistry.set(registry, out);
  return out;
}

export type ElementMapOutcome =
  | "ok"
  | "too_large"
  | "invalid_json"
  | "storage_error";

export function recordElementMapOutcome(
  registry: Registry,
  outcome: ElementMapOutcome,
): void {
  const m = getOrRegister(registry);
  m.elementMap.inc({ outcome });
}
