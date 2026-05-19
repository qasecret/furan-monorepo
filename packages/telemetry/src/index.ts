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

export { Counter, Histogram, Registry } from "prom-client";

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
