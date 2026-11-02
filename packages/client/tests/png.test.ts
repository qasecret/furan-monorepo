import { describe, expect, it } from "vitest";

import { FuranInputError, MAX_PNG_BYTES, pngSize } from "../src/index.js";

import { pngHeader, TINY_PNG } from "./helpers.js";

describe("pngSize", () => {
  it("reads width and height from IHDR", () => {
    expect(pngSize(TINY_PNG)).toEqual({ width: 1, height: 1 });
    expect(pngSize(pngHeader(400, 300))).toEqual({ width: 400, height: 300 });
  });

  it("rejects a non-PNG", () => {
    const gif = new Uint8Array(Buffer.from("GIF89a-this-is-not-a-png-at-all"));
    expect(() => pngSize(gif)).toThrow(FuranInputError);
    expect(() => pngSize(gif)).toThrow(/not a PNG/);
    expect(() => pngSize(gif, "shots/home.png")).toThrow(/shots\/home\.png/);
  });

  it("rejects zero-byte and truncated input", () => {
    expect(() => pngSize(new Uint8Array(0))).toThrow(FuranInputError);
    expect(() => pngSize(TINY_PNG.slice(0, 20))).toThrow(FuranInputError);
  });

  it("rejects an image whose first chunk is not IHDR", () => {
    const bytes = pngHeader(10, 10);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT"
    expect(() => pngSize(bytes)).toThrow(FuranInputError);
  });

  it("rejects more than 50 MB", () => {
    const big = new Uint8Array(MAX_PNG_BYTES + 1);
    big.set(pngHeader(10, 10), 0);
    expect(() => pngSize(big)).toThrow(/50 MB/);
  });
});
