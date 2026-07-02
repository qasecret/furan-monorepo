import { fileURLToPath } from "node:url";

import sharp from "sharp";

/**
 * Generate the deterministic PNG fixtures the virtual-SDK uploads. Run once;
 * the PNGs are committed so test runs never regenerate (and so diffs are
 * byte-stable). Same SVG in → same PNG out.
 *
 *   pnpm --filter @furan/e2e exec tsx src/fixtures/gen.ts
 */
const DIR = fileURLToPath(new URL(".", import.meta.url));

const svg = (square: string): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">` +
      `<rect width="400" height="300" fill="#ffffff"/>` +
      `<rect x="50" y="50" width="100" height="100" fill="${square}"/>` +
      `</svg>`,
  );

async function main(): Promise<void> {
  // baseline + identical are the SAME image (blue square) → zero diff.
  await sharp(svg("#1e40ff")).png().toFile(`${DIR}baseline.png`);
  await sharp(svg("#1e40ff")).png().toFile(`${DIR}identical.png`);
  // changed swaps the square to red → a bounded, predictable pixel diff.
  await sharp(svg("#ff2020")).png().toFile(`${DIR}changed.png`);
   
  console.log("fixtures written: baseline.png, identical.png, changed.png");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
