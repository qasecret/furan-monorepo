import { runL1Pixelmatch } from "../l1-pixelmatch.js";
import type { EngineConfig } from "../types.js";

import type { VlmProvider, VlmProviderConfig } from "./types.js";
import { vlmResultSchema } from "./types.js";

export type { VlmProvider, VlmProviderConfig, VlmResult } from "./types.js";
export type {
  OllamaVlmConfig,
  GeminiVlmConfig,
  AnthropicVlmConfig,
  BaseVlmConfig,
  VlmInput,
  VlmProviderResponse,
} from "./types.js";
export { DEFAULT_VLM_PROMPT, DEFAULT_VLM_CONFIG } from "./types.js";
export { ollamaProvider } from "./ollama.js";
export { geminiProvider } from "./gemini.js";
export { anthropicProvider } from "./anthropic.js";

/** Hard ceiling on a single VLM provider call. Ollama/Gemini/Anthropic can
 *  stall (cold model load, quota backpressure, network partition); without a
 *  timeout one hung request blocks the whole diff worker and the queue backs
 *  up unbounded. On timeout we fall back to the L1 verdict like any other
 *  provider failure. */
const VLM_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface RunVlmOptions {
  provider: VlmProvider;
  config: VlmProviderConfig;
  engineConfig: EngineConfig;
  diffThreshold: number;
  ignoreAreas?: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface VlmDiffResult {
  passed: boolean;
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageBytes: Buffer;
  vlmDescription?: string;
  /**
   * Set when the VLM layer did NOT produce a usable verdict and the result
   * fell back to the L1 pixel decision. The engine stays metrics-agnostic, so
   * it only *reports* the failure here — the diff-worker turns this into a
   * Prometheus counter + warn log so a provider outage (quota, timeout,
   * unreachable Ollama) is alertable instead of silently buried in the
   * description string. `reason` is a bounded category (safe as a metric
   * label); `message` is free-form for logs.
   */
  vlmError?: {
    reason: "empty" | "parse_error" | "call_failed";
    message: string;
  };
}

export async function runVlm(
  baseline: Buffer,
  candidate: Buffer,
  options: RunVlmOptions,
): Promise<VlmDiffResult> {
  const l1 = await runL1Pixelmatch(
    baseline,
    candidate,
    options.ignoreAreas,
    options.engineConfig,
  );

  if (l1.diffPercent === 0) {
    return {
      passed: true,
      diffPercent: 0,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
    };
  }

  try {
    const baselineBytes = new Uint8Array(baseline);
    const candidateBytes = new Uint8Array(candidate);
    const diffBytes =
      l1.diffImageBytes.length > 0
        ? new Uint8Array(l1.diffImageBytes)
        : candidateBytes;

    const response = await withTimeout(
      options.provider.generate(options.config, [
        baselineBytes,
        candidateBytes,
        diffBytes,
      ]),
      VLM_TIMEOUT_MS,
      "vlm_generate",
    );

    const content = options.config.useThinking
      ? (response.thinking ?? response.content)
      : (response.content ?? response.thinking);

    if (!content) {
      return {
        passed: l1.diffPercent <= options.diffThreshold * 100,
        diffPercent: l1.diffPercent,
        pixelMismatchCount: l1.pixelMismatchCount,
        diffImageBytes: l1.diffImageBytes,
        vlmDescription: "VLM returned empty response",
        vlmError: { reason: "empty", message: "VLM returned empty response" },
      };
    }

    // Guard JSON.parse — a provider can return non-JSON prose; treat that as a
    // parse failure (fall back to L1) rather than throwing.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return {
        passed: l1.diffPercent <= options.diffThreshold * 100,
        diffPercent: l1.diffPercent,
        pixelMismatchCount: l1.pixelMismatchCount,
        diffImageBytes: l1.diffImageBytes,
        vlmDescription: `VLM parse error: ${content}`,
        vlmError: { reason: "parse_error", message: "VLM returned non-JSON" },
      };
    }
    const parsed = vlmResultSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        passed: l1.diffPercent <= options.diffThreshold * 100,
        diffPercent: l1.diffPercent,
        pixelMismatchCount: l1.pixelMismatchCount,
        diffImageBytes: l1.diffImageBytes,
        vlmDescription: `VLM parse error: ${content}`,
        vlmError: {
          reason: "parse_error",
          message: "VLM response failed schema validation",
        },
      };
    }

    return {
      passed: parsed.data.identical,
      diffPercent: l1.diffPercent,
      pixelMismatchCount: l1.pixelMismatchCount,
      diffImageBytes: l1.diffImageBytes,
      vlmDescription: parsed.data.description,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: l1.diffPercent <= options.diffThreshold * 100,
      diffPercent: l1.diffPercent,
      pixelMismatchCount: l1.pixelMismatchCount,
      diffImageBytes: l1.diffImageBytes,
      vlmDescription: `VLM failed: ${msg}`,
      vlmError: { reason: "call_failed", message: msg },
    };
  }
}
