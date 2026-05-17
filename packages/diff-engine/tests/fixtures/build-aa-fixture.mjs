// One-off generator for candidate-a-aa-only.png.
// Loads baseline-a.png, perturbs a small region's alpha channel by +/-2
// (sub-perceptual, anti-aliasing-like noise), writes the variant.
// Run: node tests/fixtures/build-aa-fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = PNG.sync.read(readFileSync(join(here, "baseline-a.png")));
const out = new PNG({ width: src.width, height: src.height });
src.data.copy(out.data);

// Perturb a 20x20 patch near the center. Toggle alpha by +/- 2 on every
// other pixel; humans won't notice, pixel-strict diff will.
const cx = Math.floor(src.width / 2);
const cy = Math.floor(src.height / 2);
for (let y = cy - 10; y < cy + 10; y++) {
  for (let x = cx - 10; x < cx + 10; x++) {
    const i = (y * src.width + x) * 4;
    const delta = (x + y) % 2 === 0 ? 2 : -2;
    out.data[i + 3] = Math.max(0, Math.min(255, out.data[i + 3] + delta));
  }
}

writeFileSync(join(here, "candidate-a-aa-only.png"), PNG.sync.write(out));
console.log("Wrote candidate-a-aa-only.png");
