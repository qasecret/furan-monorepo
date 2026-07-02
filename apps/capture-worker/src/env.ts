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
});

export type Env = z.infer<typeof envSchema>;
