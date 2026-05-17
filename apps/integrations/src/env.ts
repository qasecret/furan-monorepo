import { z } from "zod";

/**
 * Environment schema for @furan/integrations.
 *
 * The integrations app is a hybrid: Fastify (for GitHub webhook ingress,
 * Phase 4 Task 8) + Redis Pub/Sub subscriber (for `run:*:events`, the
 * fan-out source for outbound webhooks and Slack notifications in T9).
 *
 * Several GitHub / Slack env vars are declared optional here so T7 boots
 * cleanly without secrets configured; T8/T9 will tighten validation when
 * the handlers that depend on those vars are wired in.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  INTEGRATIONS_PORT: z.coerce.number().int().min(1).max(65535).default(3400),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3300),
  HOST: z.string().default("0.0.0.0"),

  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  DATABASE_URL: z.string().min(1),

  // GitHub App (T8). Optional in T7 — the receiver isn't wired yet.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),

  // Slack outbound (T9). Optional in T7.
  SLACK_WEBHOOK_URL: z.string().url().optional(),

  OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Env = z.infer<typeof envSchema>;
