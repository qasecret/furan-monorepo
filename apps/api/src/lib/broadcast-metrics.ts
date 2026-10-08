import { Counter, Gauge, type Registry } from "@furan/telemetry";

interface RegisteredMetrics {
  published: Counter<"event">;
  flushed: Counter<"event">;
  connections: Gauge;
  rejected: Counter;
  /**
   * Authoritative live-stream count backing the DoS cap. Mirrored by the
   * `connections` Gauge for scraping, but kept as a plain integer so the
   * cap check reads a scalar directly (a Gauge only exposes its value via a
   * structured `.get()` snapshot). Node's single thread makes the
   * read-then-increment in `tryAcquireConnection` atomic.
   */
  live: number;
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
  const rejected = new Counter({
    name: "furan_sse_connections_rejected_total",
    help: "SSE stream requests rejected because the concurrent-connection cap was reached",
    registers: [registry],
  });

  const out: RegisteredMetrics = {
    published,
    flushed,
    connections,
    rejected,
    live: 0,
  };
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
/**
 * Reserve a live-SSE-connection slot if the instance is under `max`. Returns
 * `true` (and increments the live count + Gauge) when a slot was taken, or
 * `false` (and increments the rejected counter) when the cap is already
 * reached. Callers MUST pair every `true` with exactly one
 * `releaseConnection` in their teardown. Reject BEFORE hijacking the socket
 * so the caller can still send a normal 503.
 */
export function tryAcquireConnection(registry: Registry, max: number): boolean {
  const m = getOrRegister(registry);
  if (m.live >= max) {
    m.rejected.inc();
    return false;
  }
  m.live += 1;
  m.connections.inc();
  return true;
}
export function releaseConnection(registry: Registry): void {
  const m = getOrRegister(registry);
  // Guard against a double-release driving the count negative (e.g. both
  // "close" and "aborted" firing) — callers also guard with a `cleanedUp`
  // flag, this is belt-and-braces.
  if (m.live <= 0) return;
  m.live -= 1;
  m.connections.dec();
}
