import { Ollama } from "ollama";

import type {
  OllamaVlmConfig,
  VlmGenerateOptions,
  VlmProvider,
  VlmProviderConfig,
  VlmProviderResponse,
} from "./types.js";

export const ollamaProvider: VlmProvider = {
  async generate(
    config: VlmProviderConfig,
    images: Uint8Array[],
    opts?: VlmGenerateOptions,
  ): Promise<VlmProviderResponse> {
    const cfg = config as OllamaVlmConfig;
    // A fresh client per call (not cached): ollama-js only exposes a
    // client-level abort(), so a per-call instance keeps the caller's timeout
    // from cancelling other concurrent ollama requests.
    const client = new Ollama({
      host: cfg.baseUrl ?? "http://localhost:11434",
    });
    if (opts?.signal) {
      if (opts.signal.aborted) client.abort();
      else
        opts.signal.addEventListener("abort", () => client.abort(), {
          once: true,
        });
    }

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
