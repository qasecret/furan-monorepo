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
 *  up unbounded. On timeout we ABORT the request (so it isn't orphaned) and
 *  fall back to the L1 verdict like any other provider failure. */
const VLM_TIMEOUT_MS = 60_000;

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

/**
 * Extract a JSON object from an LLM response. Current models (Claude, Gemini,
 * …) routinely wrap the requested JSON in a ```json fenced block or add a prose
 * preamble despite the prompt asking for a bare object, so `JSON.parse` on the
 * raw content throws. Strip a surrounding markdown fence, then fall back to the
 * outermost `{ … }` span, before parsing.
 */
export function extractJsonObject(raw: string): string {
  let s = raw.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) s = fenced[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  return s;
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

  // Shared L1-fallback fields for every non-success return below (the L1 pixel
  // verdict the VLM layer degrades to). Success overrides `passed`.
  const fallback = {
    passed: l1.diffPercent <= options.diffThreshold * 100,
    diffPercent: l1.diffPercent,
    pixelMismatchCount: l1.pixelMismatchCount,
    diffImageBytes: l1.diffImageBytes,
  };

  // Bound the provider call AND cancel it on timeout via an AbortController the
  // provider forwards to its HTTP client — so a hung request is aborted, not
  // left running after we've already returned the L1 fallback.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VLM_TIMEOUT_MS);
  try {
    const baselineBytes = new Uint8Array(baseline);
    const candidateBytes = new Uint8Array(candidate);
    const diffBytes =
      l1.diffImageBytes.length > 0
        ? new Uint8Array(l1.diffImageBytes)
        : candidateBytes;

    const response = await options.provider.generate(
      options.config,
      [baselineBytes, candidateBytes, diffBytes],
      { signal: controller.signal },
    );

    const content = options.config.useThinking
      ? (response.thinking ?? response.content)
      : (response.content ?? response.thinking);

    if (!content) {
      return {
        ...fallback,
        vlmDescription: "VLM returned empty response",
        vlmError: { reason: "empty", message: "VLM returned empty response" },
      };
    }

    // Guard JSON.parse — a provider can return non-JSON prose; treat that as a
    // parse failure (fall back to L1) rather than throwing. `extractJsonObject`
    // first unwraps markdown-fenced / prose-preambled JSON that current models
    // emit by default, so a well-formed-but-fenced object still parses.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(extractJsonObject(content));
    } catch {
      return {
        ...fallback,
        vlmDescription: `VLM parse error: ${content}`,
        vlmError: { reason: "parse_error", message: "VLM returned non-JSON" },
      };
    }
    const parsed = vlmResultSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        ...fallback,
        vlmDescription: `VLM parse error: ${content}`,
        vlmError: {
          reason: "parse_error",
          message: "VLM response failed schema validation",
        },
      };
    }

    return {
      ...fallback,
      passed: parsed.data.identical,
      vlmDescription: parsed.data.description,
    };
  } catch (err) {
    const msg = controller.signal.aborted
      ? `VLM call timed out after ${VLM_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ...fallback,
      vlmDescription: `VLM failed: ${msg}`,
      vlmError: { reason: "call_failed", message: msg },
    };
  } finally {
    clearTimeout(timer);
  }
}
