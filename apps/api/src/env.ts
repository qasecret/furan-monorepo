import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be ≥32 chars (fail-closed)"),
  JWT_EXPIRY: z.string().default("7d"),

  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_BUCKET: z.string().default("furan-dev"),
  S3_ACCESS_KEY: z.string().default("furan"),
  S3_SECRET_KEY: z.string().default("devpw_must_be_long"),

  OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  /**
   * Optional one-shot admin seed. When BOTH keys are set AND the `users`
   * table is empty at API startup, seeds a single admin row with these
   * credentials. Ignored once any user exists. Placeholder values from
   * `.env.example` (`change-me*`) are refused so the API fails closed if
   * the operator forgets to fill them in.
   */
  FURAN_BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .email()
    .refine(
      (v) => v !== "change-me",
      "FURAN_BOOTSTRAP_ADMIN_EMAIL must be replaced from .env.example placeholder",
    )
    .optional(),
  FURAN_BOOTSTRAP_ADMIN_PASSWORD: z
    .string()
    .min(8, "FURAN_BOOTSTRAP_ADMIN_PASSWORD must be ≥8 chars")
    .refine(
      (v) => !v.startsWith("change-me-run:"),
      "FURAN_BOOTSTRAP_ADMIN_PASSWORD must be replaced from .env.example placeholder",
    )
    .optional(),

  // CORS allowlist for browser-side calls from the dashboard. Comma-separate
  // for multiple origins (e.g. dev + staging). Required because the dashboard
  // is served from a different origin than the api (browser hits
  // localhost:3000 while the dashboard is on localhost:3001 in the default
  // self-host setup), so cross-origin POSTs with JSON bodies trigger a
  // preflight that 404s without an explicit CORS plugin.
  FURAN_DASHBOARD_ORIGIN: z.string().min(1).default("http://localhost:3001"),

  // Feature flag: triage-queue / inbox router (v1 staged rollout).
  // Set to true to enable the inbox.{list,count,approve,reject} tRPC procedures.
  // Defaults to false so the router is invisible until explicitly enabled.
  INBOX_ENABLED: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof envSchema>;
