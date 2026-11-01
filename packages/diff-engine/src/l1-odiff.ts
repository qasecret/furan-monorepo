import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare } from "odiff-bin";
import { PNG } from "pngjs";

import type { L1Result } from "./l1.js";
import { ensurePngEnd } from "./png-end.js";
import type { EngineConfig } from "./types.js";

/** The 8-byte signature every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface Size {
  width: number;
  height: number;
}

/**
 * Width and height from a PNG's IHDR chunk, which always comes first, right
 * after the signature. Null for bytes that are not a PNG; odiff then reports
 * whether it can read them.
 */
function pngSize(bytes: Buffer): Size | null {
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The top-left `size` of a PNG. */
function cropPng(bytes: Buffer, size: Size): Buffer {
  const src = PNG.sync.read(bytes);
  if (src.width === size.width && src.height === size.height) return bytes;
  const dst = new PNG({ width: size.width, height: size.height });
  PNG.bitblt(src, dst, 0, 0, size.width, size.height, 0, 0);
  return PNG.sync.write(dst);
}

/** odiff backend. Native support for ignoreRegions and antialiasing flag. */
export async function runL1Odiff(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    Array<{ x: number; y: number; width: number; height: number }> | undefined,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  const cdSize = pngSize(candidate);
  // The size odiff compares: the baseline's, or the shared area below.
  let size = pngSize(baseline);
  let blBytes = baseline;
  let cdBytes = candidate;
  // A project that turned on "Allow diff dimensions" compares the area both
  // images share (R30), whether the page grew or shrank. odiff 4 counts the
  // rows and columns outside that area as changed, so both images are cropped
  // to it first; the diff image is that area, at the top-left of the page.
  if (
    engineConfig.allowDiffDimensions &&
    size &&
    cdSize &&
    (size.width !== cdSize.width || size.height !== cdSize.height)
  ) {
    size = {
      width: Math.min(size.width, cdSize.width),
      height: Math.min(size.height, cdSize.height),
    };
    blBytes = cropPng(baseline, size);
    cdBytes = cropPng(candidate, size);
  }

  // odiff 4 takes inclusive corners: `x2 = x + width - 1` ignores exactly the
  // region, as the other engines' masks do. (odiff 3 ignored every pixel in
  // reading order from the first corner to the second: whole rows, across the
  // page.) A region padding clamped to nothing has no corners.
  const ignoreRegions = (ignoreAreas ?? [])
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      x1: r.x,
      y1: r.y,
      x2: r.x + r.width - 1,
      y2: r.y + r.height - 1,
    }));

  const dir = mkdtempSync(join(tmpdir(), "furan-diff-"));
  const blPath = join(dir, "baseline.png");
  const cdPath = join(dir, "candidate.png");
  const dfPath = join(dir, "diff.png");
  try {
    writeFileSync(blPath, blBytes);
    writeFileSync(cdPath, cdBytes);
    const result = await compare(blPath, cdPath, dfPath, {
      antialiasing: engineConfig.ignoreAntialiasing,
      // Without this odiff scores a page that grew or shrank by its changed
      // area. With it a size change returns `layout-diff`, which maps to 100%
      // below, like the other engines. With "Allow diff dimensions" on, the
      // images were cropped to the same size above.
      failOnLayoutDiff: !engineConfig.allowDiffDimensions,
      // Only when there is a region: odiff-bin turns the array into
      // `--ignore=<regions>`, and the odiff 4 binary rejects an empty
      // `--ignore=` ("Invalid ignore regions format") where 3.x ignored it.
      ...(ignoreRegions.length ? { ignoreRegions } : {}),
    });
    if (result.match) {
      return {
        diffPercent: 0,
        pixelMismatchCount: 0,
        diffImageBytes: Buffer.alloc(0),
        regions: [],
      };
    }
    if (result.reason !== "pixel-diff") {
      return {
        diffPercent: 100,
        pixelMismatchCount: 0,
        diffImageBytes: Buffer.alloc(0),
        regions: [],
      };
    }
    return {
      // odiff 4 rounds its percentage to two decimals, so 40 changed pixels of
      // a 1280x800 page read 0.00% and pass a zero threshold. The exact count
      // over the compared area is what odiff 3 reported (100 * count / area,
      // in that order: 20736 px of 400² is 12.96, not 12.959999999999999).
      diffPercent: size
        ? (100 * result.diffCount) / (size.width * size.height)
        : result.diffPercentage,
      pixelMismatchCount: result.diffCount,
      // odiff 3 left off the closing IEND chunk, which browsers will not
      // decode. odiff 4 writes it; the guard stays for any image without one.
      diffImageBytes: ensurePngEnd(readFileSync(dfPath)),
      regions: [],
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
