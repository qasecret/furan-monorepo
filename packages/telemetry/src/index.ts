import type { Writable } from "node:stream";

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

export function bootstrapTelemetry(opts: BootstrapOptions): Telemetry {
  const logger = pino(
    {
      name: opts.service,
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { service: opts.service, version: opts.version },
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

/**
 * Register last-resort process-level crash guards. Without these, an
 * `unhandledRejection` (e.g. a fire-and-forget promise that rejects) or an
 * `uncaughtException` either crashes the process with an unstructured stack on
 * stderr — invisible to log aggregation — or, on older Node defaults, is
 * swallowed and leaves the service in an undefined state. We log the error
 * through the structured logger (so it carries service/version and is
 * redacted + parseable) and exit non-zero so the orchestrator restarts a
 * cleanly-dead process rather than nursing a wedged one.
 *
 * Call once per service, right after {@link bootstrapTelemetry}.
 */
export function installProcessErrorHandlers(logger: Logger): void {
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled_rejection");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught_exception");
    process.exit(1);
  });
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
