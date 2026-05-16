import { z } from "zod";

/**
 * Reads, validates, and parses environment variables against a Zod schema.
 * Throws on validation failure with a flattened error message.
 * v1.0 backend reads `process.env` only — SOPS/Vault deferred per ADR-024.
 *
 * Errors never include the env *value* — only field names + Zod's
 * structural error description. This is load-bearing for secret hygiene.
 */
export function getEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(fieldErrors)}`);
  }
  return result.data;
}

/**
 * Convenience for a single required non-empty secret. Throws with the key
 * name (never the value) when missing or empty.
 */
export function getSecret(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required env var ${key} not set`);
  }
  return value;
}
