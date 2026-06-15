import Anthropic from "@anthropic-ai/sdk";

import type {
  AnthropicVlmConfig,
  VlmProvider,
  VlmProviderConfig,
  VlmProviderResponse,
} from "./types.js";

export const anthropicProvider: VlmProvider = {
  async generate(
    config: VlmProviderConfig,
    images: Uint8Array[],
  ): Promise<VlmProviderResponse> {
    const cfg = config as AnthropicVlmConfig;
    if (!cfg.apiKey) throw new Error("Anthropic API key is required");

    const client = new Anthropic({ apiKey: cfg.apiKey });

    const imageContent = images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: Buffer.from(img).toString("base64"),
      },
    }));

    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            ...imageContent,
            { type: "text" as const, text: cfg.prompt },
          ],
        },
      ],
      temperature: cfg.temperature,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const thinkingBlock = response.content.find((b) => b.type === "thinking");

    return {
      content: textBlock?.type === "text" ? textBlock.text : undefined,
      thinking:
        thinkingBlock?.type === "thinking" ? thinkingBlock.thinking : undefined,
    };
  },
};
