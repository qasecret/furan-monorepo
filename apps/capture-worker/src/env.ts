import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  // SSRF guard: when true, capture also refuses loopback / RFC-1918 / ULA /
  // CGNAT targets. Default false — screenshotting an internal or staging app
  // on a private network is a legitimate self-host use case. Link-local /
  // cloud-metadata (169.254.0.0/16, fe80::/10) and non-http(s) schemes are
  // ALWAYS blocked regardless of this flag.
  CAPTURE_BLOCK_PRIVATE_IPS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Max concurrent capture jobs per worker process. Each job drives a
  // Playwright page (CPU + hundreds of MB RSS), so an unbounded value lets a
  // burst of enqueued captures OOM the worker. Default 4 matches the historical
  // hardcoded value; tune to the host's RAM / CPU. Mirrors the injectable
  // concurrency the webhook worker already exposes.
  CAPTURE_CONCURRENCY: z.coerce.number().int().min(1).default(4),
});

export type Env = z.infer<typeof envSchema>;
