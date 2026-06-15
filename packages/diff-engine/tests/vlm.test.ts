import { PNG } from "pngjs";
import { describe, it, expect, vi } from "vitest";

import { runVlm } from "../src/vlm/index.js";
import type { VlmProvider, VlmProviderResponse } from "../src/vlm/types.js";

function solidPng(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

const mockProvider: VlmProvider = {
  generate: vi.fn(
    async (): Promise<VlmProviderResponse> => ({
      content: JSON.stringify({
        identical: false,
        description: "Color changed from white to red",
      }),
    }),
  ),
};

describe("runVlm", () => {
  const baseline = solidPng(50, 50, 255, 255, 255);
  const candidate = solidPng(50, 50, 255, 0, 0);

  it("calls VLM provider when L1 detects a diff", async () => {
    const result = await runVlm(baseline, candidate, {
      provider: mockProvider,
      config: {
        provider: "ollama",
        model: "test",
        prompt: "test",
        temperature: 0,
      },
      engineConfig: {
        threshold: 0.1,
        ignoreAntialiasing: true,
        allowDiffDimensions: false,
      },
      diffThreshold: 0,
    });
    expect(result.vlmDescription).toContain("Color changed");
    expect(mockProvider.generate).toHaveBeenCalledOnce();
  });

  it("skips VLM when images are identical", async () => {
    vi.mocked(mockProvider.generate).mockClear();
    const result = await runVlm(baseline, baseline, {
      provider: mockProvider,
      config: {
        provider: "ollama",
        model: "test",
        prompt: "test",
        temperature: 0,
      },
      engineConfig: {
        threshold: 0.1,
        ignoreAntialiasing: true,
        allowDiffDimensions: false,
      },
      diffThreshold: 0,
    });
    expect(result.vlmDescription).toBeUndefined();
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });
});
