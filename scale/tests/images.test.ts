import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  IMAGE_SIZE,
  changeRect,
  generateDiffPng,
  generatePng,
  withTextChunk,
  type ImageKind,
} from "../src/seed/images.js";

/** Decoded RGB pixels of a PNG. */
async function pixels(png: Buffer) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Share of pixels whose RGB differs between two same-sized PNGs. */
async function changedShare(a: Buffer, b: Buffer): Promise<number> {
  const pa = await pixels(a);
  const pb = await pixels(b);
  expect([pb.width, pb.height]).toEqual([pa.width, pa.height]);
  let changed = 0;
  for (let i = 0; i < pa.data.length; i += 3) {
    if (
      pa.data[i] !== pb.data[i] ||
      pa.data[i + 1] !== pb.data[i + 1] ||
      pa.data[i + 2] !== pb.data[i + 2]
    ) {
      changed += 1;
    }
  }
  return changed / (pa.width * pa.height);
}

describe("generatePng", () => {
  it("draws screens at 1366x768 and pages at 1366x3000", async () => {
    expect(IMAGE_SIZE).toEqual({
      screen: { width: 1366, height: 768 },
      page: { width: 1366, height: 3000 },
    });
    for (const kind of ["screen", "page"] as const) {
      const meta = await sharp(await generatePng(kind, 7, "none")).metadata();
      expect(meta.format).toBe("png");
      expect([meta.width, meta.height]).toEqual([
        IMAGE_SIZE[kind].width,
        IMAGE_SIZE[kind].height,
      ]);
    }
  });

  it("gives identical bytes for the same seed, and others for another", async () => {
    const a = await generatePng("screen", 42, "small");
    const b = await generatePng("screen", 42, "small");
    expect(a.equals(b)).toBe(true);
    const c = await generatePng("screen", 43, "small");
    expect(a.equals(c)).toBe(false);
  });

  it("draws blocks, strokes and gradients, not a flat fill", async () => {
    const { data } = await pixels(await generatePng("screen", 3, "none"));
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 3) {
      colours.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    }
    expect(colours.size).toBeGreaterThan(50);
  });

  for (const kind of ["screen", "page"] as ImageKind[]) {
    it(`${kind}: small changes 0.3-0.8% of the pixels, large 15-25%`, async () => {
      const base = await generatePng(kind, 11, "none");
      const small = await changedShare(
        base,
        await generatePng(kind, 11, "small"),
      );
      expect(small).toBeGreaterThanOrEqual(0.003);
      expect(small).toBeLessThanOrEqual(0.008);
      const large = await changedShare(
        base,
        await generatePng(kind, 11, "large"),
      );
      expect(large).toBeGreaterThanOrEqual(0.15);
      expect(large).toBeLessThanOrEqual(0.25);
    });
  }
});

describe("changeRect", () => {
  /** The bounding box of the pixels that differ between two same-sized PNGs. */
  async function changedBox(a: Buffer, b: Buffer) {
    const pa = await pixels(a);
    const pb = await pixels(b);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    for (let i = 0; i < pa.data.length; i += 3) {
      if (
        pa.data[i] !== pb.data[i] ||
        pa.data[i + 1] !== pb.data[i + 1] ||
        pa.data[i + 2] !== pb.data[i + 2]
      ) {
        const x = (i / 3) % pa.width;
        const y = Math.floor(i / 3 / pa.width);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  for (const kind of ["screen", "page"] as ImageKind[]) {
    it(`${kind}: is exactly the rectangle a change inverts`, async () => {
      const base = await generatePng(kind, 21, "none");
      for (const change of ["small", "large"] as const) {
        expect(
          await changedBox(base, await generatePng(kind, 21, change)),
        ).toEqual(changeRect(kind, 21, change));
      }
    });
  }

  it("is null for no change", () => {
    expect(changeRect("screen", 21, "none")).toBeNull();
  });
});

describe("generateDiffPng", () => {
  it("is screen- or page-sized, deterministic, dark with red changed areas", async () => {
    for (const kind of ["screen", "page"] as const) {
      const png = await generateDiffPng(kind, 9);
      expect(png.equals(await generateDiffPng(kind, 9))).toBe(true);
      const { data, width, height } = await pixels(png);
      expect([width, height]).toEqual([
        IMAGE_SIZE[kind].width,
        IMAGE_SIZE[kind].height,
      ]);
      let red = 0;
      let dark = 0;
      for (let i = 0; i < data.length; i += 3) {
        const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
        if (r > 200 && g < 80 && b < 80) red += 1;
        else if (r < 100 && g < 100 && b < 100) dark += 1;
      }
      const total = width * height;
      expect(red / total).toBeGreaterThan(0.002);
      expect(red / total).toBeLessThan(0.1);
      expect(dark / total).toBeGreaterThan(0.85);
    }
    const other = await generateDiffPng("screen", 10);
    expect(other.equals(await generateDiffPng("screen", 9))).toBe(false);
  });
});

describe("withTextChunk", () => {
  it("makes new bytes that decode to the same pixels", async () => {
    const png = await generatePng("screen", 5, "none");
    const a = withTextChunk(png, "step 1");
    const b = withTextChunk(png, "step 2");
    expect(a.equals(png)).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(await changedShare(png, a)).toBe(0);
    expect(await changedShare(png, b)).toBe(0);
  });

  it("refuses bytes that are not a PNG", () => {
    expect(() => withTextChunk(Buffer.from("not a png"), "x")).toThrow(
      /not a PNG/,
    );
  });
});
