import { Ollama } from "ollama";

import type {
  OllamaVlmConfig,
  VlmProvider,
  VlmProviderConfig,
  VlmProviderResponse,
} from "./types.js";

let cachedClient: Ollama | null = null;
let cachedHost: string | undefined;

function getClient(baseUrl?: string): Ollama {
  if (cachedClient && cachedHost === baseUrl) return cachedClient;
  cachedClient = new Ollama({ host: baseUrl ?? "http://localhost:11434" });
  cachedHost = baseUrl;
  return cachedClient;
}

export const ollamaProvider: VlmProvider = {
  async generate(
    config: VlmProviderConfig,
    images: Uint8Array[],
  ): Promise<VlmProviderResponse> {
    const cfg = config as OllamaVlmConfig;
    const client = getClient(cfg.baseUrl);

    const jsonSchema = {
      type: "object" as const,
      properties: {
        identical: { type: "boolean" as const },
        description: { type: "string" as const },
      },
      required: ["identical", "description"],
    };

    const response = await client.chat({
      model: cfg.model,
      messages: [
        {
          role: "user",
          content: cfg.prompt,
          images,
        },
      ],
      stream: false,
      format: jsonSchema,
      options: {
        temperature: cfg.temperature,
      },
    });

    return {
      content: response.message.content,
      thinking: response.message.thinking,
    };
  },
};
