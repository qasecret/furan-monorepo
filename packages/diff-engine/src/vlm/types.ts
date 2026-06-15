import { z } from "zod";

export const vlmResultSchema = z.object({
  identical: z.boolean(),
  description: z.string(),
});

export type VlmResult = z.infer<typeof vlmResultSchema>;

export interface VlmInput {
  baseline: Buffer;
  candidate: Buffer;
  diff: Buffer;
}

export interface VlmProviderResponse {
  content?: string | undefined;
  thinking?: string | undefined;
}

export interface VlmProvider {
  generate(
    config: VlmProviderConfig,
    images: Uint8Array[],
  ): Promise<VlmProviderResponse>;
}

export interface BaseVlmConfig {
  prompt: string;
  temperature: number;
  useThinking?: boolean | undefined;
}

export interface OllamaVlmConfig extends BaseVlmConfig {
  provider?: "ollama" | undefined;
  model: string;
  baseUrl?: string | undefined;
}

export interface GeminiVlmConfig extends BaseVlmConfig {
  provider: "gemini";
  model: string;
  apiKey: string;
}

export interface AnthropicVlmConfig extends BaseVlmConfig {
  provider: "anthropic";
  model: string;
  apiKey: string;
}

export type VlmProviderConfig =
  | OllamaVlmConfig
  | GeminiVlmConfig
  | AnthropicVlmConfig;

export const DEFAULT_VLM_PROMPT = `You are provided with three images:
1. First image: baseline screenshot
2. Second image: new version screenshot
3. Third image: diff overlay highlighting pixel-level changes

Spot any difference in text, color, shape and position of elements — treat as different even a slight change.
Ignore minor rendering artifacts that are imperceptible to users like antialiasing.
Respond with a JSON object: { "identical": true/false, "description": "..." }
Describe the difference in about 100 words.`;

export const DEFAULT_VLM_CONFIG: OllamaVlmConfig = {
  provider: "ollama",
  model: "gemma3:12b",
  prompt: DEFAULT_VLM_PROMPT,
  temperature: 0.1,
  useThinking: false,
};
