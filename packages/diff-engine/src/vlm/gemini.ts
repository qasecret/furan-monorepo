import { GoogleGenAI } from "@google/genai";

import type {
  GeminiVlmConfig,
  VlmGenerateOptions,
  VlmProvider,
  VlmProviderConfig,
  VlmProviderResponse,
} from "./types.js";

export const geminiProvider: VlmProvider = {
  async generate(
    config: VlmProviderConfig,
    images: Uint8Array[],
    opts?: VlmGenerateOptions,
  ): Promise<VlmProviderResponse> {
    const cfg = config as GeminiVlmConfig;
    if (!cfg.apiKey) throw new Error("Gemini API key is required");

    const genAI = new GoogleGenAI({ apiKey: cfg.apiKey });

    const imageParts = images.map((img) => ({
      inlineData: {
        data: Buffer.from(img).toString("base64"),
        mimeType: "image/png" as const,
      },
    }));

    const result = await genAI.models.generateContent({
      model: cfg.model,
      contents: [{ text: cfg.prompt }, ...imageParts],
      config: {
        temperature: cfg.temperature,
        ...(opts?.signal ? { abortSignal: opts.signal } : {}),
        responseMimeType: "application/json" as const,
        responseJsonSchema: {
          type: "object" as const,
          properties: {
            identical: { type: "boolean" as const },
            description: { type: "string" as const },
          },
          required: ["identical", "description"],
        },
      },
    });

    return { content: result.text };
  },
};
