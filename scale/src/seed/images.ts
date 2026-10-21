import { crc32 } from "node:zlib";

import sharp from "sharp";

/**
 * Generated screenshots for the seed and the pipeline suite (spec §2.2, §3.3).
 *
 * An image is drawn into a raw RGB buffer from a seeded PRNG (blocks,
 * text-like strokes and gradients, laid out like a web page) and encoded as
 * PNG, so the same `(kind, seed, change)` always gives the same bytes. A
 * change inverts a rectangle of the `none` image: inverting moves every
 * channel (255 - v never equals v), so the changed share of pixels is exactly
 * the rectangle's area.
 */

export type ImageKind = "screen" | "page";
export type ImageChange = "none" | "small" | "large";

export const IMAGE_SIZE: Record<ImageKind, { width: number; height: number }> =
  {
    screen: { width: 1366, height: 768 },
    page: { width: 1366, height: 3000 },
  };

/** Share of the pixels each change inverts. */
const CHANGE_SHARE: Record<Exclude<ImageChange, "none">, number> = {
  small: 0.005,
  large: 0.2,
};

type Rgb = readonly [number, number, number];

/** mulberry32: a small, fast PRNG; deterministic for a 32-bit seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Canvas {
  readonly data: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = Buffer.alloc(width * height * 3);
  }

  /** Fills a rectangle, clipped to the canvas. */
  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const pattern = Buffer.from(c);
    for (let row = y0; row < y1; row += 1) {
      const start = (row * this.width + x0) * 3;
      this.data.fill(pattern, start, start + (x1 - x0) * 3);
    }
  }

  /** A band whose colour runs from `from` (top) to `to` (bottom). */
  verticalGradient(y: number, h: number, from: Rgb, to: Rgb): void {
    for (let i = 0; i < h; i += 1) {
      const t = h > 1 ? i / (h - 1) : 0;
      this.rect(0, y + i, this.width, 1, mix(from, to, t));
    }
  }

  /** A band whose colour runs from `from` (left) to `to` (right). */
  horizontalGradient(
    x: number,
    y: number,
    w: number,
    h: number,
    from: Rgb,
    to: Rgb,
  ): void {
    const row = Buffer.alloc(w * 3);
    for (let i = 0; i < w; i += 1) {
      const c = mix(from, to, w > 1 ? i / (w - 1) : 0);
      row[i * 3] = c[0];
      row[i * 3 + 1] = c[1];
      row[i * 3 + 2] = c[2];
    }
    for (let r = Math.max(0, y); r < Math.min(this.height, y + h); r += 1) {
      row.copy(this.data, (r * this.width + x) * 3);
    }
  }

  /** Inverts every channel of a rectangle (assumed inside the canvas). */
  invert(x: number, y: number, w: number, h: number): void {
    for (let row = y; row < y + h; row += 1) {
      const start = (row * this.width + x) * 3;
      for (let i = start; i < start + w * 3; i += 1) {
        this.data[i] = 255 - this.data[i]!;
      }
    }
  }
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const ACCENTS: Rgb[] = [
  [37, 99, 235],
  [22, 163, 74],
  [220, 38, 38],
  [217, 119, 6],
  [147, 51, 234],
  [8, 145, 178],
];
const INK: Rgb = [31, 41, 55];
const MUTED: Rgb = [107, 114, 128];

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

/** Text-like strokes: lines of "words" (short dark bars) with gaps. */
function strokes(
  canvas: Canvas,
  rand: () => number,
  x: number,
  y: number,
  w: number,
  lines: number,
  ink: Rgb,
  size: number,
): void {
  for (let line = 0; line < lines; line += 1) {
    let cx = x;
    const end = x + w * (line === lines - 1 ? 0.4 + rand() * 0.5 : 1);
    while (cx < end) {
      const word = Math.min(end - cx, 14 + Math.floor(rand() * 70));
      canvas.rect(cx, y + line * (size + 9), word, size, ink);
      cx += word + 7;
    }
  }
}

/** The page drawn for `(kind, seed)`, before any change. */
function draw(kind: ImageKind, seed: number): Canvas {
  const { width, height } = IMAGE_SIZE[kind];
  const canvas = new Canvas(width, height);
  const rand = prng(seed);
  const accent = pick(rand, ACCENTS);
  const shade = 244 + Math.floor(rand() * 8);
  canvas.rect(0, 0, width, height, [shade, shade, Math.min(255, shade + 3)]);

  // Header: a vertical gradient with a logo block and nav strokes.
  canvas.verticalGradient(0, 64, mix(accent, [0, 0, 0], 0.35), accent);
  canvas.rect(24, 16, 120, 32, [255, 255, 255]);
  strokes(canvas, rand, 220, 28, width - 480, 1, [235, 240, 255], 6);

  // Hero: a horizontal gradient band with a headline.
  const heroTo = pick(rand, ACCENTS);
  canvas.horizontalGradient(
    0,
    64,
    width,
    140,
    mix(accent, [255, 255, 255], 0.75),
    mix(heroTo, [255, 255, 255], 0.6),
  );
  strokes(canvas, rand, 48, 100, 560, 2, INK, 14);

  // Cards in three columns down to the footer.
  const gap = 24;
  const columns = 3;
  const cardW = Math.floor((width - gap * (columns + 1)) / columns);
  const footer = 72;
  let y = 64 + 140 + gap;
  while (y < height - footer - 80) {
    const cardH = Math.min(
      140 + Math.floor(rand() * 140),
      height - footer - gap - y,
    );
    for (let c = 0; c < columns; c += 1) {
      const x = gap + c * (cardW + gap);
      canvas.rect(x, y, cardW, cardH, [218, 222, 228]);
      canvas.rect(x + 1, y + 1, cardW - 2, cardH - 2, [255, 255, 255]);
      let inner = y + 16;
      if (rand() < 0.4) {
        const imgH = Math.min(70, cardH - 40);
        canvas.rect(
          x + 16,
          inner,
          cardW - 32,
          imgH,
          mix(pick(rand, ACCENTS), [255, 255, 255], 0.5),
        );
        inner += imgH + 12;
      }
      strokes(canvas, rand, x + 16, inner, Math.floor(cardW * 0.6), 1, INK, 8);
      const lines = Math.max(0, Math.floor((y + cardH - inner - 36) / 13));
      strokes(canvas, rand, x + 16, inner + 22, cardW - 32, lines, MUTED, 4);
    }
    y += cardH + gap;
  }

  canvas.rect(0, height - footer, width, footer, [17, 24, 39]);
  strokes(
    canvas,
    rand,
    48,
    height - footer + 30,
    width / 2,
    1,
    [156, 163, 175],
    5,
  );
  return canvas;
}

/** Inverts the rectangle that `change` covers, placed from the seed. */
function applyChange(canvas: Canvas, seed: number, change: ImageChange): void {
  if (change === "none") return;
  const { width, height } = canvas;
  const area = CHANGE_SHARE[change] * width * height;
  // small: a text-line-like strip; large: half the width, ~20% of the area.
  const h = change === "small" ? 24 : Math.round(area / Math.round(width / 2));
  const w = Math.min(width, Math.round(area / h));
  const rand = prng(seed ^ 0x5eed5eed);
  const x = Math.floor(rand() * (width - w + 1));
  const y = Math.floor(rand() * (height - h + 1));
  canvas.invert(x, y, w, h);
}

/**
 * A deterministic PNG: `screen` is 1366x768, `page` 1366x3000. `small`
 * changes about 0.5% of the pixels of the `none` image with the same seed,
 * `large` about 20%.
 */
export async function generatePng(
  kind: ImageKind,
  seed: number,
  change: ImageChange,
): Promise<Buffer> {
  const canvas = draw(kind, seed);
  applyChange(canvas, seed, change);
  return sharp(canvas.data, {
    raw: { width: canvas.width, height: canvas.height, channels: 3 },
  })
    .png()
    .toBuffer();
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const TEXT_KEYWORD = "furan-scale";

/**
 * `png` with a `tEXt` chunk carrying `text` inserted before `IEND`: new bytes
 * (so a new content-addressed key) that decode to the same pixels. The seed
 * uses it to give each step of the newest batch and the long run its own
 * object without drawing thousands of images.
 */
export function withTextChunk(png: Buffer, text: string): Buffer {
  const iend = png.length - 12;
  if (
    png.length < PNG_SIGNATURE.length + 12 ||
    !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    png.toString("latin1", iend + 4, iend + 8) !== "IEND"
  ) {
    throw new Error("withTextChunk: not a PNG ending in IEND");
  }
  const data = Buffer.from(`${TEXT_KEYWORD}\0${text}`, "latin1");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)]);
}
