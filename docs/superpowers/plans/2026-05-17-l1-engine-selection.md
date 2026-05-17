# L1 Engine Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `projects.imageComparison` to the diff-engine, add pixelmatch + looks-same as alternative L1 backends, expose engine selection on the project settings page, and migrate the schema default to `odiff` so existing projects preserve behavior.

**Architecture:** Strategy pattern in `packages/diff-engine`: a thin `l1.ts` dispatcher exhaustively switches on a new `engine` field in `ProjectDiffConfig` to one of three sibling files (`l1-odiff.ts`, `l1-pixelmatch.ts`, `l1-looks-same.ts`). Pixelmatch and looks-same don't natively support arbitrary ignore regions, so a shared `masking.ts` paints solid-black rectangles over the input PNGs before comparison. The diff-worker reads `project.imageComparison` and `project.imageComparisonConfig` and passes both via `ProjectDiffConfig`. A Drizzle migration flips the schema default and rewrites existing `pixelmatch` rows to `odiff` (preserves today's behavior, since every diff today is effectively odiff regardless of stored value).

**Tech Stack:** TypeScript, Node 22, Turborepo, pnpm workspaces, Drizzle ORM + PostgreSQL, Vitest, Fastify + tRPC, Next.js 15 + React 19 + Radix, Tailwind v4. Image libs: `pixelmatch` + `pngjs` (new), `looks-same` (new), `odiff-bin` (existing).

**Spec:** `docs/superpowers/specs/2026-05-17-l1-engine-selection-design.md`

---

## File Structure

| Path                                                                                                     | Status       | Responsibility                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| `packages/diff-engine/package.json`                                                                      | modify       | Add `pixelmatch`, `pngjs`, `looks-same` + `@types/*`                    |
| `packages/diff-engine/src/types.ts`                                                                      | modify       | Add `ImageComparison`, `EngineConfig`, extend `ProjectDiffConfig`       |
| `packages/diff-engine/src/masking.ts`                                                                    | create       | `applyIgnoreMask(png, areas)` — paint black RGBA rects, re-encode       |
| `packages/diff-engine/src/l1-odiff.ts`                                                                   | create       | Move existing odiff code; read antialiasing from config                 |
| `packages/diff-engine/src/l1-pixelmatch.ts`                                                              | create       | pixelmatch + pngjs implementation                                       |
| `packages/diff-engine/src/l1-looks-same.ts`                                                              | create       | looks-same implementation                                               |
| `packages/diff-engine/src/l1.ts`                                                                         | rewrite      | Exhaustive-switch dispatcher                                            |
| `packages/diff-engine/src/engine.ts`                                                                     | modify       | Pass `engine` + `engineConfig` through to `runL1`                       |
| `packages/diff-engine/src/index.ts`                                                                      | modify       | Re-export new types (`ImageComparison`, `EngineConfig`)                 |
| `packages/diff-engine/tests/fixtures/build-aa-fixture.mjs`                                               | create       | One-off script to generate `candidate-a-aa-only.png`                    |
| `packages/diff-engine/tests/fixtures/candidate-a-aa-only.png`                                            | create       | New AA-only-diff fixture                                                |
| `packages/diff-engine/tests/masking.test.ts`                                                             | create       | Unit tests for `applyIgnoreMask`                                        |
| `packages/diff-engine/tests/l1-pixelmatch.test.ts`                                                       | create       | Engine-specific tests for pixelmatch                                    |
| `packages/diff-engine/tests/l1-looks-same.test.ts`                                                       | create       | Engine-specific tests for looks-same                                    |
| `packages/diff-engine/tests/l1.test.ts`                                                                  | rewrite      | Dispatcher tests + odiff regression sub-suite                           |
| `packages/diff-engine/tests/engine.test.ts`                                                              | modify       | Add `engine`/`engineConfig` to existing test inputs                     |
| `apps/diff-worker/src/handler.ts`                                                                        | modify       | Build full `ProjectDiffConfig`; add `parseEngineConfig` helper          |
| `packages/db/src/schema/projects.ts`                                                                     | modify       | Default `'pixelmatch'` → `'odiff'`                                      |
| `packages/db/migrations/<generated>.sql`                                                                 | create (gen) | Drizzle-generated migration; manually append `UPDATE` statement         |
| `apps/api/src/trpc/v1/projects.ts`                                                                       | modify       | Add `imageComparison: z.enum(...)` to `updateInput`                     |
| `apps/dashboard/src/app/(protected)/projects/[projectId]/settings/_components/project-settings-form.tsx` | modify       | Add `<Select>` for engine in "Image comparison" card; extend Zod schema |

---

## Task 1: Add dependencies to diff-engine

**Files:**

- Modify: `packages/diff-engine/package.json`

- [ ] **Step 1: Add deps with pnpm**

Run from repo root:

```bash
pnpm --filter @furan/diff-engine add pixelmatch pngjs looks-same
pnpm --filter @furan/diff-engine add -D @types/pixelmatch @types/pngjs
```

Note: `looks-same` ships its own types, no `@types/looks-same` package needed.

- [ ] **Step 2: Verify package.json has new deps**

Run:

```bash
grep -E '"(pixelmatch|pngjs|looks-same)"' packages/diff-engine/package.json
```

Expected: three lines, one per package, with caret-prefixed versions.

- [ ] **Step 3: Verify install + typecheck still pass**

Run:

```bash
pnpm --filter @furan/diff-engine typecheck
```

Expected: no errors (no code uses the new packages yet).

- [ ] **Step 4: Commit**

```bash
git add packages/diff-engine/package.json pnpm-lock.yaml
git commit -s -m "chore(diff-engine): add pixelmatch, pngjs, looks-same deps"
```

---

## Task 2: Extend types

**Files:**

- Modify: `packages/diff-engine/src/types.ts`
- Modify: `packages/diff-engine/src/index.ts`

- [ ] **Step 1: Add new types to types.ts**

Replace the contents of `packages/diff-engine/src/types.ts` with:

```ts
export type Severity = "breaking" | "major" | "minor" | "cosmetic" | "none";
export type RegionCategory =
  | "text"
  | "color"
  | "layout"
  | "image"
  | "structural";

export interface DiffRegion {
  id: string;
  severity: Severity;
  category: RegionCategory;
  bbox: { x: number; y: number; width: number; height: number };
  description: string;
  source: "l1" | "l2";
}

export type ImageComparison = "pixelmatch" | "looks_same" | "odiff";

export interface EngineConfig {
  /** Engine-internal sensitivity. Pixelmatch: 0..1 strict→loose.
   *  Looks-same / odiff: passed through but used only as a hint. */
  threshold: number;
  /** Treat antialiased pixels as equal. Maps to odiff `antialiasing: true`,
   *  pixelmatch `includeAA: false`, looks-same `antialiasingTolerance > 0`. */
  ignoreAntialiasing: boolean;
  /** Reserved for v1.1+; plumbed but currently a no-op. */
  allowDiffDimensions: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  threshold: 0.1,
  ignoreAntialiasing: true,
  allowDiffDimensions: false,
};

export interface ProjectDiffConfig {
  diffThreshold: number;
  l2Enabled: boolean;
  ignoreAreas?: Array<{ x: number; y: number; width: number; height: number }>;
  engine: ImageComparison;
  engineConfig: EngineConfig;
}

export interface DiffResult {
  passed: boolean;
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageBytes: Buffer;
  regions: DiffRegion[];
  ranTiers: Array<"l1" | "l2">;
  durationMs: { l1: number; l2: number | null };
}
```

- [ ] **Step 2: Update index.ts re-exports**

In `packages/diff-engine/src/index.ts`, replace the type re-export block to include the new types and the constant:

```ts
export { runDiff } from "./engine.js";
export type { RunDiffInput } from "./engine.js";
export { runL1 } from "./l1.js";
export { runL2 } from "./l2.js";
export { classifyRegions } from "./classify.js";
export { DEFAULT_ENGINE_CONFIG } from "./types.js";
export type {
  DiffResult,
  DiffRegion,
  ProjectDiffConfig,
  Severity,
  RegionCategory,
  ImageComparison,
  EngineConfig,
} from "./types.js";
```

- [ ] **Step 3: Run typecheck (expected to fail — callers don't pass engine yet)**

Run:

```bash
pnpm --filter @furan/diff-engine typecheck
```

Expected: errors in `engine.ts`, tests, and any caller — `engine` and `engineConfig` now required on `ProjectDiffConfig`. **This is intentional**, those callers are updated in later tasks.

Note: We are not committing yet — the package is broken until Task 8. Tasks 2-8 land as one commit at end of Task 8.

---

## Task 3: Build the AA-only-difference fixture

**Files:**

- Create: `packages/diff-engine/tests/fixtures/build-aa-fixture.mjs`
- Create: `packages/diff-engine/tests/fixtures/candidate-a-aa-only.png`

- [ ] **Step 1: Write the fixture generator script**

Create `packages/diff-engine/tests/fixtures/build-aa-fixture.mjs`:

```js
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
```

- [ ] **Step 2: Run the generator**

Run from repo root:

```bash
node packages/diff-engine/tests/fixtures/build-aa-fixture.mjs
```

Expected output: `Wrote candidate-a-aa-only.png`

- [ ] **Step 3: Verify the fixture exists**

Run:

```bash
ls -la packages/diff-engine/tests/fixtures/candidate-a-aa-only.png
```

Expected: file exists, non-zero size.

Note: not committing yet (rolled up with Task 8).

---

## Task 4: Implement `applyIgnoreMask` with tests

**Files:**

- Create: `packages/diff-engine/src/masking.ts`
- Create: `packages/diff-engine/tests/masking.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/diff-engine/tests/masking.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";

import { applyIgnoreMask } from "../src/masking.js";

function solidPng(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("applyIgnoreMask", () => {
  it("returns input unchanged when areas is empty", () => {
    const src = solidPng(10, 10, 255, 0, 0);
    const out = applyIgnoreMask(src, []);
    expect(out.equals(src)).toBe(true);
  });

  it("paints solid black RGBA over each area", () => {
    const src = solidPng(20, 20, 255, 0, 0);
    const out = applyIgnoreMask(src, [{ x: 5, y: 5, width: 10, height: 10 }]);
    const decoded = PNG.sync.read(out);
    // Pixel inside the mask area
    const insideIdx = (10 * decoded.width + 10) * 4;
    expect(decoded.data[insideIdx]).toBe(0);
    expect(decoded.data[insideIdx + 1]).toBe(0);
    expect(decoded.data[insideIdx + 2]).toBe(0);
    expect(decoded.data[insideIdx + 3]).toBe(255);
    // Pixel outside (corner)
    const outsideIdx = (0 * decoded.width + 0) * 4;
    expect(decoded.data[outsideIdx]).toBe(255);
    expect(decoded.data[outsideIdx + 1]).toBe(0);
    expect(decoded.data[outsideIdx + 2]).toBe(0);
  });

  it("clamps areas that extend past image bounds", () => {
    const src = solidPng(10, 10, 255, 255, 255);
    // Area extends 5px past the right edge; must not throw.
    const out = applyIgnoreMask(src, [{ x: 8, y: 8, width: 100, height: 100 }]);
    const decoded = PNG.sync.read(out);
    const idx = (9 * decoded.width + 9) * 4;
    expect(decoded.data[idx]).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, expect fail (module not found)**

Run:

```bash
pnpm --filter @furan/diff-engine test tests/masking.test.ts
```

Expected: FAIL — `Cannot find module '../src/masking.js'`.

- [ ] **Step 3: Implement `applyIgnoreMask`**

Create `packages/diff-engine/src/masking.ts`:

```ts
import { PNG } from "pngjs";

export interface IgnoreArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Paints solid-black RGBA (0,0,0,255) rectangles over each area of the
 * provided PNG and returns a new PNG buffer. Used by pixelmatch and
 * looks-same backends, which don't natively support ignore regions; the
 * mask must be applied identically to both baseline and candidate so the
 * masked pixels register as equal regardless of engine.
 *
 * Areas extending past image bounds are clamped. An empty `areas` array
 * returns the input buffer unchanged.
 */
export function applyIgnoreMask(pngBytes: Buffer, areas: IgnoreArea[]): Buffer {
  if (areas.length === 0) return pngBytes;
  const png = PNG.sync.read(pngBytes);
  const { width, height, data } = png;
  for (const area of areas) {
    const x0 = Math.max(0, Math.floor(area.x));
    const y0 = Math.max(0, Math.floor(area.y));
    const x1 = Math.min(width, Math.floor(area.x + area.width));
    const y1 = Math.min(height, Math.floor(area.y + area.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}
```

- [ ] **Step 4: Run test, expect pass**

Run:

```bash
pnpm --filter @furan/diff-engine test tests/masking.test.ts
```

Expected: 3 passed.

Note: not committing yet.

---

## Task 5: Move odiff implementation to `l1-odiff.ts`

**Files:**

- Create: `packages/diff-engine/src/l1-odiff.ts`

- [ ] **Step 1: Create the new file**

Create `packages/diff-engine/src/l1-odiff.ts`:

```ts
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare } from "odiff-bin";

import type { L1Result } from "./l1.js";
import type { EngineConfig } from "./types.js";

/** odiff backend. Native support for ignoreRegions and antialiasing flag. */
export async function runL1Odiff(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  const dir = mkdtempSync(join(tmpdir(), "furan-diff-"));
  const blPath = join(dir, "baseline.png");
  const cdPath = join(dir, "candidate.png");
  const dfPath = join(dir, "diff.png");
  try {
    writeFileSync(blPath, baseline);
    writeFileSync(cdPath, candidate);
    const result = await compare(blPath, cdPath, dfPath, {
      antialiasing: engineConfig.ignoreAntialiasing,
      ignoreRegions:
        ignoreAreas?.map((r) => ({
          x1: r.x,
          y1: r.y,
          x2: r.x + r.width,
          y2: r.y + r.height,
        })) ?? [],
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
    const diffBytes = readFileSync(dfPath);
    return {
      diffPercent: result.diffPercentage,
      pixelMismatchCount: result.diffCount,
      diffImageBytes: diffBytes,
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
```

Note: `L1Result` is imported from `./l1.js` but does not exist there yet — Task 8 will define it as part of the dispatcher rewrite. Until then, this file won't typecheck. That's expected.

---

## Task 6: Implement `l1-pixelmatch.ts` with tests

**Files:**

- Create: `packages/diff-engine/src/l1-pixelmatch.ts`
- Create: `packages/diff-engine/tests/l1-pixelmatch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/diff-engine/tests/l1-pixelmatch.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL1Pixelmatch } from "../src/l1-pixelmatch.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runL1Pixelmatch", () => {
  it("returns 0 diff for identical images", async () => {
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-identical.png"),
      undefined,
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
    expect(r.pixelMismatchCount).toBe(0);
    expect(r.diffImageBytes.length).toBe(0);
  });

  it("returns non-zero diff for materially different images", async () => {
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      undefined,
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBeGreaterThan(0.5);
    expect(r.pixelMismatchCount).toBeGreaterThan(0);
    expect(r.diffImageBytes.length).toBeGreaterThan(0);
  });

  it("ignoreAreas covering the diff region zero out the result", async () => {
    // The "major" fixture differs across the full image, so a single
    // large ignore area should knock diff to 0.
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      [{ x: 0, y: 0, width: 10000, height: 10000 }],
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
  });

  it("ignoreAntialiasing=true treats AA-only changes as equal", async () => {
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-aa-only.png"),
      undefined,
      { ...DEFAULT_ENGINE_CONFIG, ignoreAntialiasing: true },
    );
    expect(r.diffPercent).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect fail (module not found)**

Run:

```bash
pnpm --filter @furan/diff-engine test tests/l1-pixelmatch.test.ts
```

Expected: FAIL — `Cannot find module '../src/l1-pixelmatch.js'`.

- [ ] **Step 3: Implement pixelmatch backend**

Create `packages/diff-engine/src/l1-pixelmatch.ts`:

```ts
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import type { L1Result } from "./l1.js";
import { applyIgnoreMask } from "./masking.js";
import type { EngineConfig } from "./types.js";

/** pixelmatch backend. ignoreAreas applied by pre-masking the buffers. */
export async function runL1Pixelmatch(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  const baselineBytes = applyIgnoreMask(baseline, ignoreAreas ?? []);
  const candidateBytes = applyIgnoreMask(candidate, ignoreAreas ?? []);
  const b = PNG.sync.read(baselineBytes);
  const c = PNG.sync.read(candidateBytes);

  if (b.width !== c.width || b.height !== c.height) {
    return {
      diffPercent: 100,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const diff = new PNG({ width: b.width, height: b.height });
  const mismatch = pixelmatch(b.data, c.data, diff.data, b.width, b.height, {
    threshold: engineConfig.threshold,
    includeAA: !engineConfig.ignoreAntialiasing,
  });

  if (mismatch === 0) {
    return {
      diffPercent: 0,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const totalPixels = b.width * b.height;
  return {
    diffPercent: (mismatch / totalPixels) * 100,
    pixelMismatchCount: mismatch,
    diffImageBytes: PNG.sync.write(diff),
    regions: [],
  };
}
```

Note: `L1Result` import will resolve once Task 8 lands; until then this file errors on the import. Expected.

- [ ] **Step 4: Run tests (expect 4 pass after Task 8)**

For now, attempting to run will fail on the `L1Result` import. Skip running until Task 8 completes; the tests will be re-run as part of Task 8's verification.

---

## Task 7: Implement `l1-looks-same.ts` with tests

**Files:**

- Create: `packages/diff-engine/src/l1-looks-same.ts`
- Create: `packages/diff-engine/tests/l1-looks-same.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/diff-engine/tests/l1-looks-same.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL1LooksSame } from "../src/l1-looks-same.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runL1LooksSame", () => {
  it("returns 0 diff for identical images", async () => {
    const r = await runL1LooksSame(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-identical.png"),
      undefined,
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
    expect(r.pixelMismatchCount).toBe(0);
    expect(r.diffImageBytes.length).toBe(0);
  });

  it("returns non-zero diff for materially different images", async () => {
    const r = await runL1LooksSame(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      undefined,
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBeGreaterThan(0);
    expect(r.pixelMismatchCount).toBeGreaterThan(0);
    expect(r.diffImageBytes.length).toBeGreaterThan(0);
  });

  it("ignoreAreas covering the diff region zero out the result", async () => {
    const r = await runL1LooksSame(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      [{ x: 0, y: 0, width: 10000, height: 10000 }],
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
  });

  it("ignoreAntialiasing=true treats AA-only changes as equal", async () => {
    const r = await runL1LooksSame(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-aa-only.png"),
      undefined,
      { ...DEFAULT_ENGINE_CONFIG, ignoreAntialiasing: true },
    );
    expect(r.diffPercent).toBe(0);
  });
});
```

- [ ] **Step 2: Implement looks-same backend**

Create `packages/diff-engine/src/l1-looks-same.ts`:

```ts
import looksSame from "looks-same";
import { PNG } from "pngjs";

import type { L1Result } from "./l1.js";
import { applyIgnoreMask } from "./masking.js";
import type { EngineConfig } from "./types.js";

/**
 * looks-same backend. pixelMismatchCount is approximate (derived from
 * cluster bounding-box areas) — looks-same doesn't expose an exact count.
 */
export async function runL1LooksSame(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  const baselineBytes = applyIgnoreMask(baseline, ignoreAreas ?? []);
  const candidateBytes = applyIgnoreMask(candidate, ignoreAreas ?? []);

  // Dimension guard.
  const bMeta = PNG.sync.read(baselineBytes);
  const cMeta = PNG.sync.read(candidateBytes);
  if (bMeta.width !== cMeta.width || bMeta.height !== cMeta.height) {
    return {
      diffPercent: 100,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const antialiasingTolerance = engineConfig.ignoreAntialiasing ? 4 : 0;

  const cmp = await looksSame(baselineBytes, candidateBytes, {
    strict: false,
    antialiasingTolerance,
    createDiffImage: false,
  });

  if (cmp.equal) {
    return {
      diffPercent: 0,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const diffImageBytes = await looksSame.createDiff({
    reference: baselineBytes,
    current: candidateBytes,
    highlightColor: "#ff0000",
    antialiasingTolerance,
    strict: false,
  });

  const totalPixels = bMeta.width * bMeta.height;
  const clusterPixels = (cmp.diffClusters ?? []).reduce((sum, cluster) => {
    const w = cluster.right - cluster.left + 1;
    const h = cluster.bottom - cluster.top + 1;
    return sum + w * h;
  }, 0);

  return {
    diffPercent: (clusterPixels / totalPixels) * 100,
    pixelMismatchCount: clusterPixels,
    diffImageBytes,
    regions: [],
  };
}
```

Note: like Task 6, the `L1Result` import resolves only after Task 8 lands. Don't run tests yet.

---

## Task 8: Rewrite `l1.ts` as dispatcher + wire `engine.ts` + run full test suite

**Files:**

- Rewrite: `packages/diff-engine/src/l1.ts`
- Modify: `packages/diff-engine/src/engine.ts`
- Rewrite: `packages/diff-engine/tests/l1.test.ts`
- Modify: `packages/diff-engine/tests/engine.test.ts`

- [ ] **Step 1: Rewrite `l1.ts` as dispatcher**

Overwrite `packages/diff-engine/src/l1.ts`:

```ts
import { runL1LooksSame } from "./l1-looks-same.js";
import { runL1Odiff } from "./l1-odiff.js";
import { runL1Pixelmatch } from "./l1-pixelmatch.js";
import type { DiffRegion, EngineConfig, ImageComparison } from "./types.js";

export interface L1Result {
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageBytes: Buffer;
  regions: DiffRegion[];
}

/**
 * Dispatches to the configured L1 backend. Exhaustive switch — adding
 * a fourth engine (e.g. VLM) without a case here fails typecheck.
 */
export async function runL1(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engine: ImageComparison,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  switch (engine) {
    case "odiff":
      return runL1Odiff(baseline, candidate, ignoreAreas, engineConfig);
    case "pixelmatch":
      return runL1Pixelmatch(baseline, candidate, ignoreAreas, engineConfig);
    case "looks_same":
      return runL1LooksSame(baseline, candidate, ignoreAreas, engineConfig);
    default: {
      const _exhaustive: never = engine;
      throw new Error(
        `Unknown image comparison engine: ${String(_exhaustive)}`,
      );
    }
  }
}
```

- [ ] **Step 2: Update `engine.ts` to pass engine + engineConfig**

Overwrite `packages/diff-engine/src/engine.ts`:

```ts
import { classifyRegions } from "./classify.js";
import { runL1 } from "./l1.js";
import { runL2 } from "./l2.js";
import type { DiffResult, ProjectDiffConfig, DiffRegion } from "./types.js";

export interface RunDiffInput {
  baseline: { image: Buffer; dom?: string };
  candidate: { image: Buffer; dom?: string };
  config: ProjectDiffConfig;
}

export async function runDiff(input: RunDiffInput): Promise<DiffResult> {
  const t0 = performance.now();
  const l1 = await runL1(
    input.baseline.image,
    input.candidate.image,
    input.config.ignoreAreas,
    input.config.engine,
    input.config.engineConfig,
  );
  const t1 = performance.now();

  const shouldRunL2 =
    input.config.l2Enabled &&
    l1.diffPercent >= input.config.diffThreshold * 100 &&
    input.baseline.dom !== undefined &&
    input.candidate.dom !== undefined;

  let l2Regions: DiffRegion[] = [];
  let l2Duration: number | null = null;
  if (shouldRunL2) {
    const t2 = performance.now();
    l2Regions = await runL2(input.baseline.dom!, input.candidate.dom!);
    l2Duration = performance.now() - t2;
  }

  const allRegions = classifyRegions([...l1.regions, ...l2Regions]);

  return {
    passed: l1.pixelMismatchCount === 0,
    diffPercent: l1.diffPercent,
    pixelMismatchCount: l1.pixelMismatchCount,
    diffImageBytes: l1.diffImageBytes,
    regions: allRegions,
    ranTiers: shouldRunL2 ? ["l1", "l2"] : ["l1"],
    durationMs: { l1: t1 - t0, l2: l2Duration },
  };
}
```

- [ ] **Step 3: Rewrite `l1.test.ts` as dispatcher test + odiff regression**

Overwrite `packages/diff-engine/tests/l1.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL1 } from "../src/l1.js";
import { DEFAULT_ENGINE_CONFIG, type ImageComparison } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runL1 dispatcher", () => {
  it.each<ImageComparison>(["odiff", "pixelmatch", "looks_same"])(
    "returns 0 diff for identical images via %s",
    async (engine) => {
      const r = await runL1(
        FIXTURE("baseline-a.png"),
        FIXTURE("candidate-a-identical.png"),
        undefined,
        engine,
        DEFAULT_ENGINE_CONFIG,
      );
      expect(r.diffPercent).toBe(0);
      expect(r.pixelMismatchCount).toBe(0);
    },
  );

  it("throws on unknown engine value", async () => {
    await expect(
      runL1(
        FIXTURE("baseline-a.png"),
        FIXTURE("candidate-a-identical.png"),
        undefined,
        "vlm" as unknown as ImageComparison,
        DEFAULT_ENGINE_CONFIG,
      ),
    ).rejects.toThrow(/Unknown image comparison engine/);
  });
});

describe("runL1 odiff regression", () => {
  it("returns 0 diff for identical images", async () => {
    const r = await runL1(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-identical.png"),
      undefined,
      "odiff",
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
    expect(r.pixelMismatchCount).toBe(0);
    expect(r.regions).toEqual([]);
  });

  it("returns non-zero diff for materially different images", async () => {
    const r = await runL1(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      undefined,
      "odiff",
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBeGreaterThan(0.5);
    expect(r.pixelMismatchCount).toBeGreaterThan(0);
  });

  it("zeros pixel diffs inside ignoreAreas", async () => {
    const r = await runL1(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      [{ x: 0, y: 0, width: 100, height: 100 }],
      "odiff",
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
  });
});
```

- [ ] **Step 4: Update `engine.test.ts` to pass engine + engineConfig**

Overwrite `packages/diff-engine/tests/engine.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runDiff } from "../src/engine.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PNG_FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));
const HTML = (n: string) =>
  readFileSync(join(__dirname, "fixtures", n), "utf8");

describe("runDiff", () => {
  it("L1 below threshold short-circuits L2", async () => {
    const result = await runDiff({
      baseline: {
        image: PNG_FIXTURE("baseline-a.png"),
        dom: HTML("dom-baseline.html"),
      },
      candidate: {
        image: PNG_FIXTURE("candidate-a-identical.png"),
        dom: HTML("dom-text-change.html"),
      },
      config: {
        diffThreshold: 0.1,
        l2Enabled: true,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toEqual(["l1"]);
    expect(result.durationMs.l2).toBeNull();
  });

  it("L1 above threshold runs L2", async () => {
    const result = await runDiff({
      baseline: {
        image: PNG_FIXTURE("baseline-a.png"),
        dom: HTML("dom-baseline.html"),
      },
      candidate: {
        image: PNG_FIXTURE("candidate-a-major.png"),
        dom: HTML("dom-text-change.html"),
      },
      config: {
        diffThreshold: 0.001,
        l2Enabled: true,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toContain("l2");
    expect(result.regions.length).toBeGreaterThan(0);
  });

  it("l2Enabled=false skips L2 regardless of L1", async () => {
    const result = await runDiff({
      baseline: {
        image: PNG_FIXTURE("baseline-a.png"),
        dom: HTML("dom-baseline.html"),
      },
      candidate: {
        image: PNG_FIXTURE("candidate-a-major.png"),
        dom: HTML("dom-text-change.html"),
      },
      config: {
        diffThreshold: 0.001,
        l2Enabled: false,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toEqual(["l1"]);
  });
});
```

- [ ] **Step 5: Run the full diff-engine test suite**

Run:

```bash
pnpm --filter @furan/diff-engine test
```

Expected: all tests pass. Total ~17 (3 masking + 4 pixelmatch + 4 looks-same + 5 l1 dispatcher/regression + 3 engine).

- [ ] **Step 6: Lint + typecheck + build**

Run:

```bash
pnpm --filter @furan/diff-engine lint && pnpm --filter @furan/diff-engine typecheck && pnpm --filter @furan/diff-engine build
```

Expected: all green.

- [ ] **Step 7: Commit Tasks 2-8 together**

```bash
git add packages/diff-engine
git commit -s -m "feat(diff-engine): add pixelmatch and looks-same L1 backends

Adds strategy-pattern dispatcher in l1.ts that selects between odiff
(default, existing), pixelmatch, and looks_same based on the project's
imageComparison setting. ignoreAreas applied natively by odiff and via
a shared applyIgnoreMask() pre-mask for pixelmatch/looks-same.

ProjectDiffConfig gains required 'engine' and 'engineConfig' fields;
callers (diff-worker) must update — wired in a follow-up commit."
```

---

## Task 9: Wire diff-worker to pass engine + engineConfig

**Files:**

- Modify: `apps/diff-worker/src/handler.ts`

- [ ] **Step 1: Inspect current handler call site**

Read `apps/diff-worker/src/handler.ts` lines 220-240 to confirm shape.

Run:

```bash
sed -n '220,240p' apps/diff-worker/src/handler.ts
```

Expected: the `runDiff({...config:{diffThreshold,l2Enabled,...ignoreAreas}})` block from the design.

- [ ] **Step 2: Add `parseEngineConfig` helper at top of handler.ts**

Open `apps/diff-worker/src/handler.ts`. Just below the existing top-of-file imports (after the last `import` statement), add:

```ts
import { z } from "zod";

import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "@furan/diff-engine";

const engineConfigSchema = z.object({
  threshold: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.threshold),
  ignoreAntialiasing: z
    .boolean()
    .default(DEFAULT_ENGINE_CONFIG.ignoreAntialiasing),
  allowDiffDimensions: z
    .boolean()
    .default(DEFAULT_ENGINE_CONFIG.allowDiffDimensions),
});

function parseEngineConfig(
  raw: string | null | undefined,
  logger: { warn: (obj: object, msg: string) => void },
  projectId: string,
): EngineConfig {
  if (!raw) return DEFAULT_ENGINE_CONFIG;
  try {
    const parsed = JSON.parse(raw);
    return engineConfigSchema.parse(parsed);
  } catch (err) {
    logger.warn(
      {
        projectId,
        rawTruncated: raw.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      },
      "image_comparison_config_invalid_falling_back_to_defaults",
    );
    return DEFAULT_ENGINE_CONFIG;
  }
}
```

If `z` or `zod` is already imported, don't duplicate the import — merge.

- [ ] **Step 3: Update the `runDiff` call site**

Find the block at `apps/diff-worker/src/handler.ts:223-237` (the `runDiff({ baseline, candidate, config: { ... } })` call). Replace the `config` object literal with:

```ts
      config: {
        diffThreshold: project.diffThreshold ?? 0.001,
        l2Enabled: project.l2Enabled ?? true,
        ...(ignoreAreas !== undefined ? { ignoreAreas } : {}),
        engine: project.imageComparison,
        engineConfig: parseEngineConfig(
          project.imageComparisonConfig,
          logger,
          project.id,
        ),
      },
```

- [ ] **Step 4: Typecheck the worker**

Run:

```bash
pnpm --filter @furan/diff-worker typecheck
```

Expected: green. If `logger` is named differently in this file's scope, adjust the call. If `project.id` lookup differs, use the local variable holding the project row id.

- [ ] **Step 5: Lint the worker**

Run:

```bash
pnpm --filter @furan/diff-worker lint
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/diff-worker/src/handler.ts
git commit -s -m "feat(diff-worker): pass project's imageComparison + config to diff engine

Reads project.imageComparison and project.imageComparisonConfig and
plumbs them via ProjectDiffConfig. Malformed JSON in
imageComparisonConfig falls back to DEFAULT_ENGINE_CONFIG with a warn
log; no other engine value is reachable since the DB enum constrains
the field."
```

---

## Task 10: Flip schema default + generate migration

**Files:**

- Modify: `packages/db/src/schema/projects.ts`
- Create (generated, then edited): `packages/db/migrations/<NNNN>_<name>.sql`

- [ ] **Step 1: Edit schema default**

In `packages/db/src/schema/projects.ts`, change line 21-23 from:

```ts
  imageComparison: imageComparisonEnum("image_comparison")
    .notNull()
    .default("pixelmatch"),
```

to:

```ts
  imageComparison: imageComparisonEnum("image_comparison")
    .notNull()
    .default("odiff"),
```

- [ ] **Step 2: Generate the migration**

Run:

```bash
pnpm --filter @furan/db db:generate
```

Expected: drizzle-kit emits a new SQL file under `packages/db/migrations/` with a fresh `NNNN_<name>.sql` (numbered after the latest existing migration, e.g. `0006_*.sql`). The generated file will contain an `ALTER TABLE "projects" ALTER COLUMN "image_comparison" SET DEFAULT 'odiff';` statement.

- [ ] **Step 3: Locate the new migration file**

Run:

```bash
ls -t packages/db/migrations/*.sql | head -1
```

Note the path. Open it for editing.

- [ ] **Step 4: Append data migration**

In the new SQL file generated by Step 2, append this statement at the end (preserving any existing statement-breakpoint markers Drizzle inserts; if there's a `--> statement-breakpoint` marker, place this after it on a new line followed by another breakpoint marker):

```sql
--> statement-breakpoint
UPDATE "projects" SET "image_comparison" = 'odiff' WHERE "image_comparison" = 'pixelmatch';
```

- [ ] **Step 5: Verify the migration file content**

Run:

```bash
cat $(ls -t packages/db/migrations/*.sql | head -1)
```

Expected: contains both the `ALTER ... SET DEFAULT 'odiff'` and the `UPDATE ... WHERE 'pixelmatch'` statements.

- [ ] **Step 6: Typecheck @furan/db**

Run:

```bash
pnpm --filter @furan/db typecheck
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/projects.ts packages/db/migrations
git commit -s -m "feat(db): flip image_comparison default to odiff + migrate existing rows

Existing projects have all been running odiff regardless of the
schema-declared pixelmatch default (engine ignored the field). Migration
preserves that behavior: schema default becomes odiff; any row still
holding 'pixelmatch' is rewritten to 'odiff'. User-chosen 'looks_same'
rows are untouched."
```

---

## Task 11: Add `imageComparison` to tRPC update schema

**Files:**

- Modify: `apps/api/src/trpc/v1/projects.ts`

- [ ] **Step 1: Edit `updateInput`**

In `apps/api/src/trpc/v1/projects.ts`, the `updateInput` schema at lines 13-24 currently has `imageComparisonConfig` but not `imageComparison`. Edit the schema to add `imageComparison` immediately above `imageComparisonConfig`:

Replace:

```ts
  imageComparisonConfig: z.string().optional(),
```

with:

```ts
  imageComparison: z.enum(["pixelmatch", "looks_same", "odiff"]).optional(),
  imageComparisonConfig: z.string().optional(),
```

The mutation body's column-passthrough loop (`for (const [k, v] of Object.entries(rest))`) handles the new field automatically — no other change required.

- [ ] **Step 2: Typecheck the api**

Run:

```bash
pnpm --filter @furan/api typecheck
```

Expected: green.

- [ ] **Step 3: Lint the api**

Run:

```bash
pnpm --filter @furan/api lint
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/trpc/v1/projects.ts
git commit -s -m "feat(api): accept imageComparison on projects.update tRPC mutation"
```

---

## Task 12: Add engine dropdown to dashboard project settings

**Files:**

- Modify: `apps/dashboard/src/app/(protected)/projects/[projectId]/settings/_components/project-settings-form.tsx`

- [ ] **Step 1: Import Select primitives**

In the imports block of `project-settings-form.tsx` (after the `Input` and `Slider` imports), add:

```ts
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

- [ ] **Step 2: Extend the Zod form schema**

Inside the existing `const schema = z.object({...})` block, add `imageComparison` between `autoApproveFeature` and `retentionDays`:

```ts
  imageComparison: z.enum(["pixelmatch", "looks_same", "odiff"]),
```

- [ ] **Step 3: Add `imageComparison` to form `defaultValues`**

In the `useForm` config, add `imageComparison: "odiff"` to `defaultValues`:

```ts
      autoApproveFeature: false,
      imageComparison: "odiff",
      retentionDays: 90,
```

- [ ] **Step 4: Add `imageComparison` to the `form.reset` call in the `useEffect`**

In the `form.reset({...})` call inside the project-load `useEffect`, add:

```ts
        autoApproveFeature: project.autoApproveFeature ?? false,
        imageComparison: project.imageComparison ?? "odiff",
        retentionDays: project.retentionDays ?? 90,
```

- [ ] **Step 5: Add the `<Select>` field inside the "Image comparison" `<Card>`**

In the "Image comparison" Card (the one with `<CardTitle>Image comparison</CardTitle>`), add a new `FormField` ABOVE the existing `imageComparisonConfig` textarea:

```tsx
<FormField
  control={form.control}
  name="imageComparison"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Algorithm</FormLabel>
      <Select value={field.value} onValueChange={field.onChange}>
        <FormControl>
          <SelectTrigger data-testid="image-comparison-select">
            <SelectValue />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="odiff">Odiff (default)</SelectItem>
          <SelectItem value="pixelmatch">Pixelmatch</SelectItem>
          <SelectItem value="looks_same">Looks-Same</SelectItem>
        </SelectContent>
      </Select>
      <FormDescription>
        L1 pixel comparison backend. Odiff is the default; Pixelmatch matches
        the jest-image-snapshot / Percy world; Looks-Same is perceptual and
        antialiasing-tolerant.
      </FormDescription>
      <FormMessage />
    </FormItem>
  )}
/>
```

- [ ] **Step 6: Typecheck the dashboard**

Run:

```bash
pnpm --filter @furan/dashboard typecheck
```

Expected: green.

- [ ] **Step 7: Lint the dashboard**

Run:

```bash
pnpm --filter @furan/dashboard lint
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/app/\(protected\)/projects/\[projectId\]/settings
git commit -s -m "feat(dashboard): add image-comparison engine selector to project settings"
```

---

## Task 13: Cross-package verification + final commit

**Files:** (none modified — verification only)

- [ ] **Step 1: Run the full repo lint + typecheck + test**

Run from repo root:

```bash
pnpm lint && pnpm typecheck && pnpm turbo run test --concurrency=1
```

Expected: all green. `--concurrency=1` matches CI's serialization for Postgres-touching tests.

- [ ] **Step 2: Build everything**

Run:

```bash
pnpm build
```

Expected: every package builds.

- [ ] **Step 3: Review the full diff one more time**

Run:

```bash
git log --oneline main..HEAD
git diff main..HEAD --stat
```

Expected: ~6 commits, files touched only in `packages/diff-engine`, `packages/db`, `apps/diff-worker`, `apps/api`, `apps/dashboard`.

- [ ] **Step 4: Optional manual smoke**

If a dev stack is convenient:

```bash
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml up -d postgres redis minio minio-init
pnpm --filter @furan/db exec drizzle-kit migrate
pnpm --filter @furan/api dev &
pnpm --filter @furan/diff-worker dev &
pnpm --filter @furan/dashboard dev &
```

Then in the dashboard, change a project's algorithm to Pixelmatch (or Looks-Same), trigger a diff (via SDK or `/runs` POST), and confirm in the worker logs that the engine reflects the selection and `diffPercent` is a sane value.

- [ ] **Step 5: Verification-complete checklist (no commit)**

Before declaring done, confirm:

- All unit tests pass in `packages/diff-engine`
- All typechecks pass across `@furan/diff-engine`, `@furan/diff-worker`, `@furan/db`, `@furan/api`, `@furan/dashboard`
- Migration file contains BOTH the `ALTER ... SET DEFAULT 'odiff'` and `UPDATE ... WHERE 'pixelmatch'` statements
- The settings page renders the engine dropdown (manual or trust-the-types)
- `git status` is clean

---

## Notes for the implementing engineer

- **TDD ordering matters here.** Tasks 4–7 are TDD: write the test, watch it fail (mod the cross-task `L1Result` import in Tasks 5–7, which is documented inline), then implement. The Task 8 mass-run is where all pieces converge — that's the moment to confirm everything is green.
- **Why one combined commit for Tasks 2–8?** The diff-engine package is in an intermediate-broken state for several tasks (types changed, implementations not all in place, imports referencing not-yet-existing exports). Splitting into smaller commits would leave the repo unable to build at intermediate points — that's worse than a single larger commit. Tasks 9 onwards each leave the tree buildable, so they commit independently.
- **No raw drizzle outside `@furan/db`.** The diff-worker imports the enum type indirectly through `project.imageComparison` (a typed column read). If you find yourself importing from `drizzle-orm` in the worker, you've taken a wrong turn — go through `@furan/db` re-exports.
- **The `allowDiffDimensions` field is plumbed but unused.** That's intentional per the spec — kept in the type for forward-compat. Don't implement it in this PR.
- **Don't bump @furan/diff-engine's version field.** The package is private (`"private": true`) and gets a workspace `workspace:*` reference from consumers. The release-please workflow only touches the public app images and the Kotlin SDK.
