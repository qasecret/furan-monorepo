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
});

export type Env = z.infer<typeof envSchema>;
