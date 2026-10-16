import { PNG } from "pngjs";
import { describe, it, expect } from "vitest";

import { ensurePngEnd } from "../src/png-end.js";

/** The constant IEND chunk: length 0, type "IEND", its CRC. */
const IEND = Buffer.from("0000000049454e44ae426082", "hex");

function encodedPng(): Buffer {
  const png = new PNG({ width: 4, height: 3 });
  for (let i = 0; i < 4 * 3; i++) {
    png.data[i * 4] = 200;
    png.data[i * 4 + 1] = i * 10;
    png.data[i * 4 + 2] = 30;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("ensurePngEnd", () => {
  it("appends IEND to a PNG that lacks it, and the result decodes", () => {
    const whole = encodedPng();
    expect(whole.subarray(-12).equals(IEND)).toBe(true);
    const truncated = whole.subarray(0, whole.length - 12);

    const repaired = ensurePngEnd(truncated);

    expect(repaired.length).toBe(truncated.length + 12);
    expect(repaired.subarray(-12).equals(IEND)).toBe(true);
    expect(repaired.equals(whole)).toBe(true);
    const decoded = PNG.sync.read(repaired);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
  });

  it("returns a complete PNG unchanged, byte for byte", () => {
    const whole = encodedPng();
    const out = ensurePngEnd(whole);
    expect(out).toBe(whole);
    expect(out.equals(encodedPng())).toBe(true);
  });

  it("returns an empty buffer unchanged", () => {
    const empty = Buffer.alloc(0);
    expect(ensurePngEnd(empty)).toBe(empty);
    expect(ensurePngEnd(empty).length).toBe(0);
  });

  it("returns bytes that are not a PNG unchanged", () => {
    const text = Buffer.from("definitely not a png, and no IEND either");
    expect(ensurePngEnd(text)).toBe(text);
    const short = Buffer.from([0x89, 0x50, 0x4e]);
    expect(ensurePngEnd(short)).toBe(short);
  });
});
