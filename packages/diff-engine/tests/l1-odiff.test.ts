import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { PNG } from "pngjs";
import { describe, it, expect } from "vitest";

import { runL1Odiff } from "../src/l1-odiff.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

/** The constant IEND chunk: length 0, type "IEND", its CRC. */
const IEND = Buffer.from("0000000049454e44ae426082", "hex");

function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * `odiff-bin` unpacks a native executable at install time (its postinstall
 * copies the one for this platform to `bin/odiff.exe`). When that is missing
 * or not executable (an install that skipped scripts, an unsupported
 * platform) the test is skipped, with the reason, not failed.
 */
function odiffUnavailable(): string | null {
  let bin: string;
  try {
    const entry = createRequire(import.meta.url).resolve("odiff-bin");
    bin = join(dirname(entry), "bin", "odiff.exe");
  } catch (err) {
    return `odiff-bin could not be resolved: ${String(err)}`;
  }
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    return `odiff binary is missing or not executable at ${bin}`;
  }
  return null;
}

const skipReason = odiffUnavailable();

describe.skipIf(skipReason !== null)(
  `runL1Odiff diff image${skipReason ? ` (SKIPPED: ${skipReason})` : ""}`,
  () => {
    it("is a complete PNG: it ends with IEND and decodes", async () => {
      const baseline = solidPng(24, 16, [255, 255, 255]);
      const candidate = solidPng(24, 16, [10, 120, 200]);

      const r = await runL1Odiff(
        baseline,
        candidate,
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.pixelMismatchCount).toBeGreaterThan(0);
      const bytes = r.diffImageBytes;
      expect(bytes.length).toBeGreaterThan(IEND.length);
      expect(bytes.subarray(-IEND.length).equals(IEND)).toBe(true);
      const decoded = PNG.sync.read(bytes);
      expect(decoded.width).toBe(24);
      expect(decoded.height).toBe(16);
    });
  },
);
