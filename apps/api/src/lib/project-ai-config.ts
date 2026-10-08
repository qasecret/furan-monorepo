/**
 * ADR-060 — Visual-AI provider settings in `projects.image_comparison_config`.
 *
 * The blob holds both the pixel-engine knobs and the VLM provider config
 * (`provider`, `model`, `prompt`, `temperature`, `apiKey`, `baseUrl`).
 *
 * - `apiKey` is write-only: no read path returns it (`toPublicProject`).
 *   On update an object that omits `apiKey` keeps the stored key, `""` /
 *   `null` clears it, a non-empty value replaces it
 *   (`mergeImageComparisonConfig`) — so a client that round-trips the
 *   redacted blob never clobbers the key.
 * - `provider` / `baseUrl` / `apiKey` decide where screenshots are sent and
 *   whose account is billed, so changing them is admin-only
 *   (`providerSettingsChanged`).
 *
 * Pure helpers — no DB, no I/O.
 */

type ConfigObject = Record<string, unknown>;

/**
 * Parse a stored/incoming config. Empty → `{}`; a JSON object → itself;
 * anything else (invalid JSON, arrays, scalars, null) → `null`.
 */
function parseConfig(raw: string | null | undefined): ConfigObject | null {
  if (raw === null || raw === undefined || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ConfigObject;
    }
    return null;
  } catch {
    return null;
  }
}

function hasKey(config: ConfigObject): boolean {
  return typeof config.apiKey === "string" && config.apiKey !== "";
}

const serialize = (config: ConfigObject): string =>
  JSON.stringify(config, null, 2);

/** True for `""` (no override) or a JSON object. */
export function isValidImageComparisonConfig(raw: string): boolean {
  return parseConfig(raw) !== null;
}

/**
 * The config as any reader may see it: `apiKey` removed, plus whether one is
 * configured. A stored blob that doesn't parse is never echoed back — it
 * could hold a key the redaction can't locate.
 */
export function redactImageComparisonConfig(raw: string | null | undefined): {
  config: string;
  hasApiKey: boolean;
} {
  const config = parseConfig(raw);
  if (config === null) return { config: "", hasApiKey: false };
  if (!("apiKey" in config)) return { config: raw ?? "", hasApiKey: false };
  const { apiKey: _apiKey, ...rest } = config;
  return { config: serialize(rest), hasApiKey: hasKey(config) };
}

/** A project row safe to return to any caller (see ADR-060). */
export function toPublicProject<T extends { imageComparisonConfig: string }>(
  row: T,
): T & { hasVlmApiKey: boolean } {
  const { config, hasApiKey } = redactImageComparisonConfig(
    row.imageComparisonConfig,
  );
  return { ...row, imageComparisonConfig: config, hasVlmApiKey: hasApiKey };
}

/**
 * Apply write-only key semantics to an incoming config (already validated
 * with `isValidImageComparisonConfig`). Returns the string to store.
 */
export function mergeImageComparisonConfig(
  storedRaw: string | null | undefined,
  incomingRaw: string,
): string {
  if (incomingRaw.trim() === "") return "";
  const incoming = parseConfig(incomingRaw);
  if (incoming === null) return incomingRaw;
  const stored = parseConfig(storedRaw) ?? {};

  if (!("apiKey" in incoming)) {
    if (!hasKey(stored)) return incomingRaw;
    return serialize({ ...incoming, apiKey: stored.apiKey });
  }
  if (incoming.apiKey === "" || incoming.apiKey === null) {
    const { apiKey: _apiKey, ...rest } = incoming;
    return serialize(rest);
  }
  return incomingRaw;
}

/** The admin-only subset, normalized (absent provider ≡ the default). */
function providerSettings(raw: string | null | undefined) {
  const config = parseConfig(raw) ?? {};
  return {
    provider: config.provider ?? "ollama",
    baseUrl: config.baseUrl ?? "",
    apiKey: config.apiKey ?? "",
  };
}

/**
 * Whether going from `storedRaw` to `nextRaw` (the merged value about to be
 * stored) changes `provider`, `baseUrl`, or `apiKey`.
 */
export function providerSettingsChanged(
  storedRaw: string | null | undefined,
  nextRaw: string | null | undefined,
): boolean {
  const a = providerSettings(storedRaw);
  const b = providerSettings(nextRaw);
  return (
    a.provider !== b.provider ||
    a.baseUrl !== b.baseUrl ||
    a.apiKey !== b.apiKey
  );
}

/**
 * Audit description of a config change: which sub-keys changed, and what
 * happened to the key — never its value.
 */
export function describeConfigChange(
  storedRaw: string | null | undefined,
  nextRaw: string | null | undefined,
): { changedKeys: string[]; apiKey?: "set" | "replaced" | "cleared" } {
  const a = parseConfig(storedRaw) ?? {};
  const b = parseConfig(nextRaw) ?? {};
  const changedKeys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
  const before = hasKey(a);
  const after = hasKey(b);
  if (!before && after) return { changedKeys, apiKey: "set" };
  if (before && !after) return { changedKeys, apiKey: "cleared" };
  if (before && after && a.apiKey !== b.apiKey) {
    return { changedKeys, apiKey: "replaced" };
  }
  return { changedKeys };
}
