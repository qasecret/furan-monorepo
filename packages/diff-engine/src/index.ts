import type { EngineConfig } from "./types.js";

export { runDiff } from "./engine.js";
export type { RunDiffInput } from "./engine.js";
export { runL1 } from "./l1.js";
export { runAxe } from "./axe.js";
export type { AccessibilityOptions } from "./axe.js";
export { classifyRegions, severityRank } from "./classify.js";
export {
  computeCheckpointSignature,
  EXCLUDED_SOURCES,
} from "./checkpoint-signature.js";
export { DEFAULT_ENGINE_CONFIG } from "./types.js";
export type {
  DiffResult,
  DiffRegion,
  ProjectDiffConfig,
  Severity,
  RegionCategory,
  ImageComparison,
  EngineConfig,
} from "./types.js";

export { runVlm } from "./vlm/index.js";
export type {
  VlmProvider,
  VlmProviderConfig,
  VlmDiffResult,
  RunVlmOptions,
  OllamaVlmConfig,
  GeminiVlmConfig,
  AnthropicVlmConfig,
  VlmResult,
} from "./vlm/index.js";
export { DEFAULT_VLM_PROMPT, DEFAULT_VLM_CONFIG } from "./vlm/index.js";
export {
  ollamaProvider,
  geminiProvider,
  anthropicProvider,
} from "./vlm/index.js";

export type MatchLevel =
  | "Strict"
  | "Layout"
  | "Content"
  | "IgnoreColors"
  | "Dynamic";

/**
 * Image-first (ADR-047): every matchLevel maps to the single image compare.
 * The matchLevel enum is retained on the wire/SDK for back-compat, but the
 * old L1-vs-L2 tier routing is gone — DOM/L2 is no longer a comparison tier.
 * (ADR-039 introduced the routing; ADR-047 reverses it.) `runL2Only` is kept
 * in the return shape (always false) so existing callers' destructuring is
 * undisturbed; it is removed wholesale in a later cleanup.
 */
export function configForMatchLevel(
  baseConfig: EngineConfig,
  _matchLevel: MatchLevel,
): { config: EngineConfig; runL1: boolean; runL2Only: boolean } {
  return { config: baseConfig, runL1: true, runL2Only: false };
}
