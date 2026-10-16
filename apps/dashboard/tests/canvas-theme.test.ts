import { describe, expect, test } from "vitest";

import {
  applyCanvasBackground,
  cssHexToPixi,
  FALLBACK_CANVAS_BG,
  FALLBACK_CANVAS_DIVIDER,
  FALLBACK_CANVAS_HATCH,
  readCanvasBackground,
  readCanvasDivider,
  readCanvasHatch,
} from "../src/components/diff-viewer/canvas-theme";

describe("cssHexToPixi", () => {
  test("parses a lowercase 6-digit hex", () => {
    expect(cssHexToPixi("#08080a")).toBe(0x08080a);
  });

  test("trims whitespace and accepts uppercase", () => {
    expect(cssHexToPixi(" #FAFAFA ")).toBe(0xfafafa);
  });

  test("returns null for non-hex colour syntaxes", () => {
    expect(cssHexToPixi("rgb(1 2 3)")).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(cssHexToPixi("")).toBeNull();
  });
});

describe("readCanvasBackground", () => {
  test("reads --hover from the given root", () => {
    const el = document.createElement("div");
    el.style.setProperty("--hover", "#1d1d21");
    expect(readCanvasBackground(el)).toBe(0x1d1d21);
  });

  test("ignores --sunken (the letterbox follows --hover)", () => {
    const el = document.createElement("div");
    el.style.setProperty("--sunken", "#08080a");
    expect(readCanvasBackground(el)).toBe(FALLBACK_CANVAS_BG);
  });

  test("falls back when --hover is not set", () => {
    const el = document.createElement("div");
    expect(readCanvasBackground(el)).toBe(0xf3f4f6);
    expect(FALLBACK_CANVAS_BG).toBe(0xf3f4f6);
  });
});

describe("readCanvasHatch", () => {
  test("reads --fg-muted from the given root", () => {
    const el = document.createElement("div");
    el.style.setProperty("--fg-muted", "#8b8b94");
    expect(readCanvasHatch(el)).toBe(0x8b8b94);
  });

  test("falls back to the light theme's --fg-muted when it is not set", () => {
    const el = document.createElement("div");
    expect(readCanvasHatch(el)).toBe(FALLBACK_CANVAS_HATCH);
    expect(FALLBACK_CANVAS_HATCH).toBe(0x6a6a73);
  });
});

describe("readCanvasDivider", () => {
  test("reads --ring from the given root", () => {
    const el = document.createElement("div");
    el.style.setProperty("--ring", "#a8ff53");
    expect(readCanvasDivider(el)).toBe(0xa8ff53);
  });

  test("falls back to the light theme's --ring when it is not set", () => {
    const el = document.createElement("div");
    expect(readCanvasDivider(el)).toBe(FALLBACK_CANVAS_DIVIDER);
    expect(FALLBACK_CANVAS_DIVIDER).toBe(0x4d7c0f);
  });
});

describe("applyCanvasBackground", () => {
  test("sets the colour on every initialised app and skips apps without a renderer", () => {
    const a = { renderer: { background: { color: 0 as unknown } } };
    const b = { renderer: { background: { color: 0 as unknown } } };
    expect(() => applyCanvasBackground([a, b, {}], 0x0b0b0d)).not.toThrow();
    expect(a.renderer.background.color).toBe(0x0b0b0d);
    expect(b.renderer.background.color).toBe(0x0b0b0d);
  });
});
