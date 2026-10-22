import { Histogram, type Registry } from "@furan/telemetry";
import type { ProcedureType, TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import type { FastifyInstance } from "fastify";

/**
 * Buckets (seconds) of both latency histograms. They run from 5 ms, a cached
 * read, to 10 s, a request that is already failing its caller.
 */
const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

/** How a tRPC procedure ended: `server_error` is a 5xx, `client_error` any other failure. */
export type ProcedureOutcome = "ok" | "client_error" | "server_error";

/** The part of tRPC's middleware result the outcome depends on. */
export type ProcedureResult = { ok: true } | { ok: false; error: TRPCError };

interface RequestMetrics {
  http: Histogram<"method" | "route" | "status_class">;
  procedure: Histogram<"procedure" | "type" | "outcome">;
}

const metricsByRegistry = new WeakMap<Registry, RequestMetrics>();

/**
 * Register the two histograms on `registry`, once. A second call with the same
 * registry reuses the first call's metrics (prom-client throws on a duplicate
 * registration, and tests build many apps on fresh registries).
 *
 * No ids in any label: `route` is the route template (`/api/v1/storage/:key`,
 * never the URL), `procedure` is the router path.
 */
function getOrRegister(registry: Registry): RequestMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const http = new Histogram({
    name: "furan_http_request_duration_seconds",
    help: "Time an HTTP request took to answer, by method, route template and status class",
    labelNames: ["method", "route", "status_class"] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });
  const procedure = new Histogram({
    name: "furan_trpc_procedure_duration_seconds",
    help: "Time a tRPC procedure took, authorization and request transaction included, by procedure, type and outcome",
    labelNames: ["procedure", "type", "outcome"] as const,
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });
  const out: RequestMetrics = { http, procedure };
  metricsByRegistry.set(registry, out);
  return out;
}

/** A status code's class. Total: a code outside 100-599 still lands in a bounded label. */
export function classifyStatus(code: number): StatusClass {
  if (code < 200) return "1xx";
  if (code < 300) return "2xx";
  if (code < 400) return "3xx";
  if (code < 500) return "4xx";
  return "5xx";
}

/**
 * `ok` when the procedure returned; otherwise `server_error` when its error
 * maps to a 5xx (an unexpected throw, wrapped by tRPC as INTERNAL_SERVER_ERROR)
 * and `client_error` for the rest (FORBIDDEN, NOT_FOUND, BAD_REQUEST, ...).
 */
export function procedureOutcome(result: ProcedureResult): ProcedureOutcome {
  if (result.ok) return "ok";
  return getHTTPStatusCodeFromError(result.error) >= 500
    ? "server_error"
    : "client_error";
}

/**
 * Routes whose latency says nothing about a request: `/metrics` (the scrape
 * itself) and the SSE streams (`.../events`), which stay open for as long as
 * the client listens.
 */
export function shouldRecordRoute(route: string): boolean {
  return route !== "/metrics" && !route.endsWith("/events");
}

/** An observation prom-client accepts: finite and not negative. */
function isObservable(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/**
 * Observe `furan_http_request_duration_seconds` for every response, from an
 * `onResponse` hook. Register it before any route so the hook covers them all.
 *
 * `route` is the matched route template, or `unmatched` when none matched (a
 * 404), so a scanner probing random paths adds one series, not one per path.
 */
export function registerRequestMetrics(
  app: FastifyInstance,
  registry: Registry,
): void {
  const { http } = getOrRegister(registry);
  app.addHook("onResponse", (req, reply, done) => {
    const route = req.routeOptions.url ?? "unmatched";
    const seconds = reply.elapsedTime / 1000;
    if (shouldRecordRoute(route) && isObservable(seconds)) {
      http.observe(
        {
          method: req.method,
          route,
          status_class: classifyStatus(reply.statusCode),
        },
        seconds,
      );
    }
    done();
  });
}

/**
 * Observe `furan_trpc_procedure_duration_seconds` for one procedure call.
 * A duration that is negative or not finite is skipped: prom-client rejects it,
 * and a metric must not fail the call it describes.
 */
export function recordProcedure(
  registry: Registry,
  call: { procedure: string; type: ProcedureType; outcome: ProcedureOutcome },
  seconds: number,
): void {
  const { procedure } = getOrRegister(registry);
  if (isObservable(seconds)) procedure.observe(call, seconds);
}
