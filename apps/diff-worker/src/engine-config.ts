import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@furan/diff-engine";
import { z } from "zod";

export const engineConfigSchema = z.object({
  threshold: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.threshold),
  ignoreAntialiasing: z
    .boolean()
    .default(DEFAULT_ENGINE_CONFIG.ignoreAntialiasing),
  allowDiffDimensions: z
    .boolean()
    .default(DEFAULT_ENGINE_CONFIG.allowDiffDimensions),
});

/**
 * What went wrong parsing a config, without any of its content: the blob
 * can hold the Visual-AI provider API key (ADR-060), and V8's JSON.parse
 * messages quote the input, so neither the raw text nor `err.message` is
 * safe to log.
 */
function describeParseError(
  err: unknown,
):
  | { reason: "invalid_json" }
  | { reason: "schema_mismatch"; issues: { path: string; code: string }[] } {
  if (err instanceof z.ZodError) {
    return {
      reason: "schema_mismatch",
      issues: err.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
    };
  }
  return { reason: "invalid_json" };
}

/**
 * Parse the pixel-engine knobs out of `projects.image_comparison_config`.
 * Unknown keys (the Visual-AI fields sharing the blob) are ignored. On
 * failure, warn with safe metadata only and fall back to the defaults.
 */
export function parseEngineConfig(
  raw: string | null | undefined,
  logger: { warn: (obj: object, msg: string) => void },
  projectId: string,
): EngineConfig {
  if (!raw) return DEFAULT_ENGINE_CONFIG;
  try {
    return engineConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn(
      { projectId, ...describeParseError(err), rawLength: raw.length },
      "image_comparison_config_invalid_falling_back_to_defaults",
    );
    return DEFAULT_ENGINE_CONFIG;
  }
}

/**
 * Replace every occurrence of `secret` in `text` with `[redacted]`. Used on
 * Visual-AI error text before it's logged or persisted, in case a provider
 * SDK echoes the API key back. Values shorter than 8 characters aren't
 * treated as secrets (too likely to match ordinary words).
 */
export function redactSecret(text: string, secret: unknown): string {
  if (typeof secret !== "string" || secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}
