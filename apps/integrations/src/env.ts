import { z } from "zod";

/**
 * Environment schema for @furan/integrations.
 *
 * The integrations app is a hybrid: Fastify (for GitHub webhook ingress,
 * Phase 4 Task 8) + Redis Pub/Sub subscriber (for `run:*:events`, the
 * fan-out source for outbound webhooks and Slack notifications in T9).
 *
 * The three `GITHUB_APP_*` vars remain optional so dev environments without
 * App credentials still boot, but T8 adds a `.refine()` enforcing the group
 * is all-or-nothing — partial config silently disabling the receiver was a
 * common foot-gun in pre-v1.0 dogfooding.
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    INTEGRATIONS_PORT: z.coerce.number().int().min(1).max(65535).default(3400),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3300),
    HOST: z.string().default("0.0.0.0"),

    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    DATABASE_URL: z.string().min(1),

    // GitHub App (T8). Optional as a group — set ALL three to enable the
    // webhook receiver + commit-status updater, or leave ALL three unset to
    // boot with the receiver disabled. The `.refine()` below rejects
    // partial configs.
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),

    // Slack outbound (T9). Optional in T7. Empty string is treated as
    // unset so the documented compose stack — which passes
    // `SLACK_WEBHOOK_URL: ${SLACK_WEBHOOK_URL:-}` — boots cleanly when
    // the operator hasn't configured Slack yet.
    SLACK_WEBHOOK_URL: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .transform((v) => (v ? v : undefined)),

    OTLP_ENDPOINT: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .transform((v) => (v ? v : undefined)),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  })
  .refine(
    (env) => {
      const present = [
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        env.GITHUB_APP_WEBHOOK_SECRET,
      ].filter((v) => v !== undefined && v !== "").length;
      return present === 0 || present === 3;
    },
    {
      message:
        "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET must all be set together or all omitted",
    },
  );

export type Env = z.infer<typeof envSchema>;
