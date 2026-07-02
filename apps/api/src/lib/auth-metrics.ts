import { Counter, type Registry } from "@furan/telemetry";

/**
 * Security-signal metric: every rejected authentication attempt, labelled by
 * reason. Spikes surface credential stuffing / brute force (`invalid_jwt`,
 * `invalid_credentials`), probing of disabled accounts (`account_inactive`),
 * or scanning of protected routes with no creds (`missing_credentials`).
 *
 * `reason` is a small closed set — safe cardinality for a Prometheus label.
 * Registered once per telemetry Registry via a WeakMap so repeated calls (and
 * test-isolated registries) don't double-register the series — the same
 * pattern as `broadcast-metrics.ts`.
 */
export type AuthFailureReason =
  | "missing_credentials"
  | "invalid_pat"
  | "invalid_token_format"
  | "invalid_jwt"
  | "account_inactive"
  | "invalid_credentials";

const byRegistry = new WeakMap<Registry, Counter<"reason">>();

function getOrRegister(registry: Registry): Counter<"reason"> {
  const existing = byRegistry.get(registry);
  if (existing) return existing;
  const counter = new Counter({
    name: "furan_auth_failures_total",
    help: "Rejected authentication attempts, labelled by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  byRegistry.set(registry, counter);
  return counter;
}

export function recordAuthFailure(
  registry: Registry,
  reason: AuthFailureReason,
): void {
  getOrRegister(registry).inc({ reason });
}
