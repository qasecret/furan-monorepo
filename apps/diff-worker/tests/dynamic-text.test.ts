import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  evaluateDynamicTextRegions,
  __resetTesseractWorkerForTests,
} from "../src/dynamic-text.js";
import type { ParsedIgnoreArea } from "../src/handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 64×32 PNG fixture. Since we mock tesseract.js entirely, the fixture's
// pixel content doesn't matter — sharp().extract() only needs a valid PNG
// of the expected dimensions.
const FIXTURE_PNG = readFileSync(
  join(__dirname, "fixtures", "date-text-region.png"),
);

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof evaluateDynamicTextRegions>[2];
const logger = mockLogger;

const region = (
  overrides: Partial<ParsedIgnoreArea> = {},
): ParsedIgnoreArea => ({
  x: 0,
  y: 0,
  width: 64,
  height: 32,
  viewport: "1280x720",
  paddingPx: 0,
  kind: "ignore",
  ...overrides,
});

// Mock the tesseract.js dynamic import. The worker calls
// `await import("tesseract.js")` lazily — vi.mock applies module-wide so
// the dynamic import resolves to the mocked factory below.
vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: "Mar 5, 2026" } })),
    terminate: vi.fn(),
  })),
}));

describe("evaluateDynamicTextRegions", () => {
  beforeEach(() => {
    __resetTesseractWorkerForTests();
  });

  test("returns empty when no dynamic-text regions", async () => {
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      [region({ kind: "ignore" }), region({ kind: "ignore" })],
      logger,
    );
    expect(result).toEqual([]);
  });

  test("matches the date preset against 'Mar 5, 2026'", async () => {
    const datePreset = String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s\-\/]+\d{1,2},?\s+\d{2,4}\b`;
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      [region({ kind: "dynamic-text", pattern: datePreset })],
      logger,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.regionIndex).toBe(0);
    expect(result[0]!.ocrText).toBe("Mar 5, 2026");
    expect(result[0]!.matched).toBe(true);
  });

  test("returns matched=false when pattern does not match OCR text", async () => {
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      [region({ kind: "dynamic-text", pattern: "ZZZZ-NOTHING" })],
      logger,
    );
    expect(result[0]!.matched).toBe(false);
  });

  test("empty OCR text never matches even a permissive pattern", async () => {
    const { createWorker } = await import("tesseract.js");
    (createWorker as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => ({
        recognize: vi.fn(async () => ({ data: { text: "  " } })),
        terminate: vi.fn(),
      }),
    );
    __resetTesseractWorkerForTests();
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      [region({ kind: "dynamic-text", pattern: ".*" })],
      logger,
    );
    expect(result[0]!.matched).toBe(false);
  });

  test("tesseract init failure returns all unmatched", async () => {
    const { createWorker } = await import("tesseract.js");
    (createWorker as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error("init failed");
      },
    );
    __resetTesseractWorkerForTests();
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      [
        region({ kind: "dynamic-text", pattern: ".+" }),
        region({ kind: "dynamic-text", pattern: ".+" }),
      ],
      logger,
    );
    expect(result.map((r) => r.matched)).toEqual([false, false]);
    expect(result.map((r) => r.ocrText)).toEqual([null, null]);
  });

  test("hard cap at 10 dynamic regions", async () => {
    const regions: ParsedIgnoreArea[] = Array.from({ length: 15 }, () =>
      region({ kind: "dynamic-text", pattern: "." }),
    );
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      regions,
      logger,
    );
    expect(result).toHaveLength(10);
  });

  test("invalid stored regex → unmatched, doesn't break batch", async () => {
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      [
        region({ kind: "dynamic-text", pattern: "((" }),
        region({ kind: "dynamic-text", pattern: ".+" }),
      ],
      logger,
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.matched).toBe(false);
    expect(result[1]!.matched).toBe(true);
  });

  test("regionIndex points into the input allRegions array", async () => {
    const result = await evaluateDynamicTextRegions(
      FIXTURE_PNG,
      [
        region({ kind: "ignore" }),
        region({ kind: "ignore" }),
        region({ kind: "dynamic-text", pattern: ".+" }),
        region({ kind: "ignore" }),
        region({ kind: "dynamic-text", pattern: ".+" }),
      ],
      logger,
    );
    expect(result.map((r) => r.regionIndex)).toEqual([2, 4]);
  });
});
