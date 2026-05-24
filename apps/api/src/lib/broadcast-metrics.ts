import { Counter, Gauge, type Registry } from "@furan/telemetry";

interface RegisteredMetrics {
  published: Counter<"event">;
  flushed: Counter<"event">;
  connections: Gauge;
}

const metricsByRegistry = new WeakMap<Registry, RegisteredMetrics>();

function getOrRegister(registry: Registry): RegisteredMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const published = new Counter({
    name: "furan_project_event_published_total",
    help: "Raw project-channel events published by the broadcaster",
    labelNames: ["event"] as const,
    registers: [registry],
  });
  const flushed = new Counter({
    name: "furan_project_sse_events_flushed_total",
    help: "SSE frames flushed to project-channel subscribers (debounced batches)",
    labelNames: ["event"] as const,
    registers: [registry],
  });
  const connections = new Gauge({
    name: "furan_project_sse_connections_active",
    help: "Currently-open project SSE connections",
    registers: [registry],
  });

  const out: RegisteredMetrics = { published, flushed, connections };
  metricsByRegistry.set(registry, out);
  return out;
}

export function recordPublished(registry: Registry, event: string): void {
  getOrRegister(registry).published.inc({ event });
}
export function recordFlushed(
  registry: Registry,
  event: string,
  count: number,
): void {
  getOrRegister(registry).flushed.inc({ event }, count);
}
export function incConnections(registry: Registry): void {
  getOrRegister(registry).connections.inc();
}
export function decConnections(registry: Registry): void {
  getOrRegister(registry).connections.dec();
}
