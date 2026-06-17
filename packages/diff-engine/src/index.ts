import type { EngineConfig } from "./types.js";

export { runDiff } from "./engine.js";
export type { RunDiffInput } from "./engine.js";
export { runL1 } from "./l1.js";
export { runL2 } from "./l2.js";
export { runAxe } from "./axe.js";
export type { AccessibilityOptions } from "./axe.js";
export { classifyRegions } from "./classify.js";
export { computeCheckpointSignature } from "./checkpoint-signature.js";
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
 * Maps a per-checkpoint matchLevel onto Furan's existing engine knobs
 * (ADR-038 §7.2). v1.1.0 implements Strict, Layout, Content. IgnoreColors
 * and Dynamic fall back to Strict — ADR-039 / ADR-040 will replace these
 * with proper engine paths.
 */
export function configForMatchLevel(
  baseConfig: EngineConfig,
  matchLevel: MatchLevel,
): { config: EngineConfig; runL1: boolean; runL2Only: boolean } {
  switch (matchLevel) {
    case "Layout":
      return { config: baseConfig, runL1: false, runL2Only: true };
    case "Content":
      return {
        config: {
          ...baseConfig,
          ignoreAntialiasing: true,
          threshold: Math.max(baseConfig.threshold, 0.2),
        },
        runL1: true,
        runL2Only: false,
      };
    case "IgnoreColors":
    case "Dynamic":
    case "Strict":
    default:
      return { config: baseConfig, runL1: true, runL2Only: false };
  }
}
