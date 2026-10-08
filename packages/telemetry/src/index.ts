import type { Writable } from "node:stream";

import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import pino, { type Logger } from "pino";
import { Registry, collectDefaultMetrics } from "prom-client";

export { Counter, Gauge, Histogram, Registry } from "prom-client";

export interface BootstrapOptions {
  service: string;
  version: string;
  /** Off by default per ops-observability.md §4.6; OTLP exports only if set. */
  otlpEndpoint?: string;
  /** Sampling ratio for traces; default 0.05. Error spans always recorded. */
  sampleRatio?: number;
  /** Test-injection seam — defaults to process.stdout when absent. */
  destination?: Writable;
}

export interface Telemetry {
  logger: Logger;
  metrics: Registry;
  shutdown: () => Promise<void>;
}

const REDACT_PATHS = [
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "Authorization",
  "*.Authorization",
  "token",
  "*.token",
];

/**
 * pino `mixin` that injects the active span's ids for trace↔log correlation.
 * Returns an empty object when no span is recording (tracing disabled, or
 * outside any span), so it is a zero-cost no-op in the default no-OTLP setup.
 */
function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  // A never-sampled / invalid context carries an all-zero trace id — skip it
  // rather than stamping a meaningless "00000000..." onto the log.
  if (!ctx.traceId || /^0+$/.test(ctx.traceId)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export function bootstrapTelemetry(opts: BootstrapOptions): Telemetry {
  const logger = pino(
    {
      name: opts.service,
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { service: opts.service, version: opts.version },
      // Trace↔log correlation: when a request/job runs inside an active OTel
      // span (only when OTLP tracing is enabled below), stamp its trace/span
      // ids onto every log line so a log can be pivoted to its trace. A no-op
      // — returns {} — when no span is active, so it costs nothing when
      // tracing is off (the default).
      mixin: traceContextMixin,
    },
    opts.destination ?? process.stdout,
  );

  const metrics = new Registry();
  metrics.setDefaultLabels({ service: opts.service, version: opts.version });
  collectDefaultMetrics({ register: metrics });

  let sdk: NodeSDK | null = null;
  if (opts.otlpEndpoint) {
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: opts.service,
        [ATTR_SERVICE_VERSION]: opts.version,
      }),
      traceExporter: new OTLPTraceExporter({ url: opts.otlpEndpoint }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
  }

  return {
    logger,
    metrics,
    shutdown: async () => {
      if (sdk) await sdk.shutdown();
    },
  };
}

export interface ProcessErrorHandlerOptions {
  /** Test-injection seam for the process exit — defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Flush the logger's (possibly async) destination, then exit. Bounded by a
 * short timer so a stuck/async transport can never keep the dying process
 * alive — with the default sync stdout destination the fatal line is already
 * written and `flush`'s callback fires promptly, so exit is effectively
 * immediate; the timer only matters for a remote/OTLP pino transport.
 */
function flushThenExit(
  logger: Logger,
  code: number,
  exitFn: (code: number) => void,
): void {
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    exitFn(code);
  };
  const timer = setTimeout(exit, 500);
  timer.unref();
  try {
    logger.flush(exit);
  } catch {
    exit();
  }
}

/**
 * Build the `unhandledRejection` / `uncaughtException` handlers without
 * registering them on `process`. Exposed so the behavior is unit-testable
 * (the process-global handlers can't be exercised without killing the test
 * runner); {@link installProcessErrorHandlers} is the wiring you call in a
 * service.
 */
export function makeProcessErrorHandlers(
  logger: Logger,
  opts: ProcessErrorHandlerOptions = {},
): {
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (err: unknown) => void;
} {
  const exitFn = opts.exit ?? ((code: number) => process.exit(code));
  return {
    // A stray unhandledRejection is usually a fire-and-forget best-effort
    // write (telemetry / broadcast / audit) that rejected — NOT a reason to
    // kill the whole worker and abandon in-flight jobs, which then requeue and
    // turn one transient error into repeated lost work. Log it and keep
    // serving; this deliberately overrides Node's default crash-on-unhandled-
    // rejection. A genuinely fatal bug will still surface as an
    // uncaughtException (below) or a failed health check.
    onUnhandledRejection: (reason) => {
      logger.error({ err: reason }, "unhandled_rejection");
    },
    // An uncaughtException means an error reached the event loop with no
    // handler — process state is genuinely undefined. Log fatal, flush so the
    // line isn't lost on an async destination, then exit non-zero so the
    // orchestrator restarts a cleanly-dead process rather than nursing a
    // wedged one.
    onUncaughtException: (err) => {
      logger.fatal({ err }, "uncaught_exception");
      flushThenExit(logger, 1, exitFn);
    },
  };
}

/**
 * Register last-resort process-level crash guards. Without these, an
 * `unhandledRejection` (e.g. a fire-and-forget promise that rejects) or an
 * `uncaughtException` either crashes the process with an unstructured stack on
 * stderr — invisible to log aggregation — or, on older Node defaults, is
 * swallowed and leaves the service in an undefined state. We log the error
 * through the structured logger (so it carries service/version and is redacted
 * + parseable). `uncaughtException` exits non-zero (state is undefined);
 * `unhandledRejection` is logged and tolerated (see {@link
 * makeProcessErrorHandlers}).
 *
 * Call once per service, right after {@link bootstrapTelemetry}.
 */
export function installProcessErrorHandlers(
  logger: Logger,
  opts: ProcessErrorHandlerOptions = {},
): void {
  const { onUnhandledRejection, onUncaughtException } = makeProcessErrorHandlers(
    logger,
    opts,
  );
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
}

/**
 * Structured last-ditch logger for a failure during startup, *before*
 * {@link bootstrapTelemetry} has produced a logger (e.g. `getEnv` throws on a
 * bad env, or telemetry bootstrap itself fails). Emits a single JSON line so
 * log aggregation still captures it, then the caller exits non-zero.
 */
export function logStartupFatal(service: string, err: unknown): void {
  const payload = {
    level: "fatal",
    service,
    msg: "startup_failed",
    err: err instanceof Error ? (err.stack ?? err.message) : String(err),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
