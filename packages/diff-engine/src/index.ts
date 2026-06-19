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
 * Image-first (ADR-047): every matchLevel maps to the single image compare,
 * so this returns the base engine config unchanged. The matchLevel enum is
 * retained on the wire/SDK for back-compat; the old L1-vs-L2 tier routing
 * (ADR-039) is gone.
 */
export function configForMatchLevel(
  baseConfig: EngineConfig,
  _matchLevel: MatchLevel,
): EngineConfig {
  return baseConfig;
}
