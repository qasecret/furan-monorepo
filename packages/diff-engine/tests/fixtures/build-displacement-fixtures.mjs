// Build deterministic baseline + synthetically-shifted candidate PNGs
// for the l1-displacement tests. Vendoring 2 MB of binary fixtures is
// wasteful when we can synthesize them in 200 lines of code, and
// committing pre-generated binaries makes it hard to tweak the test
// content. Run this script before the tests; the output PNGs are
// gitignored.
//
// Usage:
//   node packages/diff-engine/tests/fixtures/build-displacement-fixtures.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WIDTH = 256;
const HEIGHT = 256;

function makeBaseline() {
  const img = new PNG({ width: WIDTH, height: HEIGHT });
  // Striped pattern with varied frequencies so phase correlation has
  // signal to lock onto. A flat color produces a low-confidence peak.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const idx = (y * WIDTH + x) * 4;
      const v = ((Math.sin(x / 8) + Math.sin(y / 12) + Math.sin((x + y) / 16)) *
        60 + 128) | 0;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

function shiftBuffer(baselinePng, dx, dy) {
  const src = PNG.sync.read(baselinePng);
  const out = new PNG({ width: src.width, height: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const srcX = x - dx;
      const srcY = y - dy;
      const oi = (y * src.width + x) * 4;
      if (srcX >= 0 && srcX < src.width && srcY >= 0 && srcY < src.height) {
        const si = (srcY * src.width + srcX) * 4;
        out.data[oi] = src.data[si];
        out.data[oi + 1] = src.data[si + 1];
        out.data[oi + 2] = src.data[si + 2];
        out.data[oi + 3] = src.data[si + 3];
      } else {
        // Exposed band: zero (black). The test checks detection, not
        // alignment quality, so the band content doesn't matter.
        out.data[oi] = 0;
        out.data[oi + 1] = 0;
        out.data[oi + 2] = 0;
        out.data[oi + 3] = 255;
      }
    }
  }
  return PNG.sync.write(out);
}

function makeNoise() {
  const img = new PNG({ width: WIDTH, height: HEIGHT });
  // Deterministic LCG so the noise fixture is stable across runs.
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 256;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rand();
    img.data[i + 1] = rand();
    img.data[i + 2] = rand();
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img);
}

const baseline = makeBaseline();
writeFileSync(join(__dirname, "displacement-baseline.png"), baseline);

const shifted = shiftBuffer(baseline, 0, 40);
writeFileSync(join(__dirname, "displacement-shifted-down-40.png"), shifted);

const shiftedX = shiftBuffer(baseline, 25, 0);
writeFileSync(join(__dirname, "displacement-shifted-right-25.png"), shiftedX);

const noise = makeNoise();
writeFileSync(join(__dirname, "displacement-noise.png"), noise);

console.log("Wrote 4 displacement fixtures to", __dirname);
