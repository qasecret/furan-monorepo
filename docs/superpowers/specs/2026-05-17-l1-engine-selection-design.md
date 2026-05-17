# L1 Engine Selection — Design Spec

**Date:** 2026-05-17
**Author:** rabindrabiswal1@gmail.com (via Claude collaboration)
**Status:** Draft — pending implementation
**Related plan:** `/Users/rabindrabiswal/.claude/plans/what-are-things-we-joyful-engelbart.md` (item #1, Tier 1)

---

## Context

Furan's database schema declares an `image_comparison` enum (`pixelmatch | looks_same | odiff`) with a default of `"pixelmatch"` and a JSON `image_comparison_config` column on `projects`. None of this is wired: `packages/diff-engine/src/l1.ts` unconditionally runs odiff, and `apps/diff-worker/src/handler.ts:223-237` builds `ProjectDiffConfig` without passing the engine field through. Every project, regardless of stored setting, runs odiff today.

This is both a **bug** (a previously-aspirational schema field silently overridden) and a **feature gap** vs Visual Regression Tracker (VRT), which lets each project choose between pixelmatch (the JS-VRT-ecosystem default — Chromatic, Percy, jest-image-snapshot are all pixelmatch-derived), looks-same (perceptual, antialiasing-tolerant), and odiff. Closing the gap lowers the migration cost for teams coming from those tools.

**Outcome:** users can pick their L1 comparison engine per project from the dashboard; the diff worker honors that selection; existing projects keep their current behavior (odiff) with no surprise switches.

## Scope

### In scope

- Wire `imageComparison` and `imageComparisonConfig` through `ProjectDiffConfig` → `runL1` dispatcher → engine-specific implementations.
- Implement L1 backends for **pixelmatch** and **looks-same** alongside the existing **odiff** backend.
- Database migration that flips the default to `"odiff"` and migrates existing `"pixelmatch"` rows to `"odiff"` (preserves current behavior).
- Minimal dashboard UI: engine `<Select>` on the project settings page.
- Unit tests per engine + dispatcher tests + adjusted existing engine.test.ts.
- tRPC update procedure accepts `imageComparison` (verify it does; add if missing).

### Out of scope

- VLM (fourth engine) — separate spec, item #12 of the plan.
- Per-run engine override — VRT doesn't have it, no demand.
- Full project settings page (threshold, retention, l2Enabled UI) — dropdown only.
- `allowDiffDimensions` semantic enforcement — field stays plumbed but is a no-op (documented limitation).
- ADR in furan-design repo — flag for follow-up; this is "finish what was started" rather than a reversal.

## Architecture

```
diff-worker handler
   ↓ reads project.imageComparison + imageComparisonConfig from DB
   ↓ builds ProjectDiffConfig (now includes engine + engineConfig)
runDiff(input)  [packages/diff-engine/src/engine.ts]
   ↓ calls runL1 (new signature)
runL1  [l1.ts — dispatcher]
   ↓ switch on engine
   ├── runL1Odiff       [l1-odiff.ts — native ignoreAreas]
   ├── runL1Pixelmatch  [l1-pixelmatch.ts — pixelmatch + pngjs]
   └── runL1LooksSame   [l1-looks-same.ts — looks-same]
       shared: applyIgnoreMask(buf, areas) in masking.ts
   ↓ all return L1Result (same shape)
back to runDiff → L2 → classify → result
```

Blast radius: `packages/diff-engine/`, `apps/diff-worker/src/handler.ts`, one Drizzle migration, the project settings page in `apps/dashboard`, and the tRPC project update schema if it doesn't already accept `imageComparison`.

## Components

### `packages/diff-engine/` — new and changed files

| File                   | Status    | Purpose                                                                                                                                                                                                                          |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/l1.ts`            | rewritten | Dispatcher. Same exported `runL1` name + `L1Result` shape; exhaustive switch on `config.engine`.                                                                                                                                 |
| `src/l1-odiff.ts`      | new       | Current `l1.ts` body, moved verbatim, with `antialiasing` driven by `engineConfig.ignoreAntialiasing` instead of hardcoded `true`.                                                                                               |
| `src/l1-pixelmatch.ts` | new       | Pixelmatch + pngjs. Pre-masks ignoreAreas via `applyIgnoreMask`.                                                                                                                                                                 |
| `src/l1-looks-same.ts` | new       | Looks-same. Pre-masks ignoreAreas via `applyIgnoreMask`.                                                                                                                                                                         |
| `src/masking.ts`       | new       | `applyIgnoreMask(pngBuffer, areas): Buffer` — decode, paint solid black rectangles (RGBA `0,0,0,255`) over each area, re-encode. Same color in both baseline and candidate masks guarantees masked pixels register as identical. |
| `src/types.ts`         | edited    | `ProjectDiffConfig` gains `engine: ImageComparison` and `engineConfig: EngineConfig`. New exported types `ImageComparison` and `EngineConfig`.                                                                                   |
| `src/engine.ts`        | edited    | Passes `engine` + `engineConfig` through to `runL1`.                                                                                                                                                                             |
| `package.json`         | edited    | Add `pixelmatch`, `pngjs`, `looks-same` + their `@types/*` devDeps.                                                                                                                                                              |

### Outside the package

| File                                                                        | Change                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/diff-worker/src/handler.ts:223-237`                                   | Build `ProjectDiffConfig` with `engine: project.imageComparison`, `engineConfig: parseEngineConfig(project.imageComparisonConfig)`.                                                                                                                      |
| `packages/db/migrations/<new>.sql`                                          | `ALTER TABLE projects ALTER COLUMN image_comparison SET DEFAULT 'odiff'; UPDATE projects SET image_comparison = 'odiff' WHERE image_comparison = 'pixelmatch';`                                                                                          |
| `packages/db/src/schema/projects.ts:21-23`                                  | Default literal `"pixelmatch"` → `"odiff"`.                                                                                                                                                                                                              |
| `apps/dashboard/src/app/(protected)/projects/[projectId]/settings/page.tsx` | Engine `<Select>` (3 options). Wires to existing `projects.update` tRPC mutation.                                                                                                                                                                        |
| `apps/api/src/trpc/v1/projects.ts:13-24`                                    | **Verified missing.** Add `imageComparison: z.enum(["pixelmatch","looks_same","odiff"]).optional()` to `updateInput`. The mutation's column-passthrough loop (`for (const [k, v] of Object.entries(rest))`) handles the rest — no further wiring needed. |

## Data flow

End-to-end trace of a diff job:

1. BullMQ delivers `DiffJob` to `apps/diff-worker`.
2. Handler loads project row — now reads `.imageComparison` + `.imageComparisonConfig`.
3. Handler builds `ProjectDiffConfig`:
   ```ts
   {
     diffThreshold: project.diffThreshold,       // L1→L2 gate (existing)
     l2Enabled: project.l2Enabled,                // existing
     ignoreAreas: [...],                          // existing
     engine: project.imageComparison,             // NEW
     engineConfig: parseEngineConfig(project.imageComparisonConfig),  // NEW
   }
   ```
4. `runDiff(input)` orchestration unchanged.
5. `runL1` dispatcher branches on `config.engine`:
   - **odiff**: temp PNGs → `odiff-bin` with `antialiasing=engineConfig.ignoreAntialiasing`, `ignoreRegions=ignoreAreas` (native). Returns `L1Result`.
   - **pixelmatch**: `applyIgnoreMask` on both buffers → decode via `pngjs.PNG.sync.read` → `pixelmatch(b.data, c.data, diffBuf, w, h, {threshold: engineConfig.threshold, includeAA: !engineConfig.ignoreAntialiasing})` → encode diff PNG via `pngjs.PNG.sync.write` → `diffPercent = (mismatchCount / (w*h)) * 100`. Returns `L1Result`.
   - **looks-same**: masked buffers → `looksSame.createDiff({reference, current, highlightColor:'#ff0000', antialiasingTolerance: engineConfig.ignoreAntialiasing ? 4 : 0})` → `looksSame(...)` to get clusters + equality → `pixelMismatchCount` derived from cluster bounding-box areas. Returns `L1Result`.
6. `runDiff` continues with L2 escalation decision based on `diffPercent` vs `diffThreshold` (unchanged).
7. Worker uploads `diffImageBytes` (unchanged).

### Invariants

- All three engines return `L1Result` with `diffPercent` as **percent** (0–100), not fraction.
- `diffImageBytes` is a PNG with the same dimensions as inputs, or `Buffer.alloc(0)` if identical.
- `pixelMismatchCount` is exact for odiff/pixelmatch; **approximate (from cluster bboxes)** for looks-same — documented in code comment on `runL1LooksSame`.
- `regions: []` at L1 for all three (no spatial L1 regions in v1.0).
- Dimension mismatch (`baseline.w !== candidate.w` or heights differ) short-circuits to `{diffPercent: 100, pixelMismatchCount: 0, diffImageBytes: empty, regions: []}` for all three. `engineConfig.allowDiffDimensions` is plumbed but a no-op.

## Error handling

### Malformed `imageComparisonConfig` JSON

`parseEngineConfig` (in worker) uses `JSON.parse` + Zod. On failure: log `warn` with `projectId` + truncated raw value (200 chars), fall back to defaults `{threshold: 0.1, ignoreAntialiasing: true, allowDiffDimensions: false}`. Run continues.

### Unknown engine value

DB enum constrains values, but the dispatcher uses an exhaustive switch with a `never` check:

```ts
default: {
  const _exhaustive: never = config.engine;
  throw new Error(`Unknown image comparison engine: ${_exhaustive}`);
}
```

Forgetting a case when VLM lands fails at typecheck, not in production.

### Engine internal failure

Each `runL1*` throws on internal error with engine name in the message. No auto-fallback between engines (would hide config bugs). BullMQ retry handles the failure as it does today.

### Migration safety

- Single `UPDATE` is atomic per row; Drizzle migrations run in a transaction.
- Idempotent: WHERE clause becomes a no-op after first run.
- Rollback: `ALTER ... SET DEFAULT 'pixelmatch'` reverses cleanly; the data update doesn't reverse, but no rows are lost and user-chosen `looks_same` rows are untouched.

## Testing

### `packages/diff-engine/tests/`

**`l1-pixelmatch.test.ts`** (new) — 5 tests:

- identical images → `diffPercent === 0`, `pixelMismatchCount === 0`, empty `diffImageBytes`
- material diff → `diffPercent > 0.5`, `pixelMismatchCount > 0`, non-empty `diffImageBytes`
- `ignoreAreas` covering diff region → `diffPercent === 0`
- `threshold: 0` (strict) vs `threshold: 0.5` (loose) on near-identical input → strict catches it, loose doesn't
- `ignoreAntialiasing: true` on AA-only-difference fixture → `diffPercent === 0`

**`l1-looks-same.test.ts`** (new) — 4 tests:

- identical → 0/0/empty
- material diff → non-zero + non-empty `diffImageBytes`
- `ignoreAreas` masks diff → 0
- `ignoreAntialiasing` flag changes tolerance behavior

**`l1.test.ts`** (rewritten) — dispatcher:

- All three engines on identical inputs → `diffPercent === 0` (sanity)
- `engine: "odiff"` regression sub-suite: keeps existing 3 odiff assertions
- Invalid engine (cast via `as any`) → throws

**`engine.test.ts`** (edited): existing 3 tests get `engine: "odiff"` + `engineConfig: DEFAULTS` added to `config` — regression guard for the pipeline.

### Fixtures

Reuse `baseline-a.png`, `candidate-a-identical.png`, `candidate-a-major.png`. Add one new fixture `candidate-a-aa-only.png` for AA-only differences — generated by a one-off script (`tests/fixtures/build-aa-fixture.mjs`, committed alongside the PNG) that loads `baseline-a.png` via pngjs, perturbs a small region's alpha channel by ±2 (sub-perceptual antialiasing-like noise), and writes out the variant. The script is reproducible; tests load the resulting PNG, not the script.

### Not tested

- End-to-end through worker — requires Postgres+Redis+MinIO containers; type system enforces the worker handler is updated (`ProjectDiffConfig` requires the new fields).
- Settings dropdown UI — Playwright e2e overkill for a `<select>`; rely on TypeScript + manual smoke.
- Migration rollback — covered by Drizzle framework guarantees.

## Verification before declaring done

Per `superpowers:verification-before-completion`, run in order:

1. `pnpm --filter @furan/diff-engine test` — all new + old tests green
2. `pnpm --filter @furan/diff-engine lint && pnpm --filter @furan/diff-engine typecheck`
3. `pnpm --filter @furan/db db:generate` — migration generates cleanly; inspect SQL
4. `pnpm --filter @furan/diff-worker typecheck` — worker compiles against new `ProjectDiffConfig`
5. `pnpm --filter @furan/api typecheck && pnpm --filter @furan/dashboard typecheck`
6. `pnpm --filter @furan/diff-engine build`
7. Manual smoke (optional, recommended): `docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml up -d postgres redis minio minio-init`, run a diff for each engine via API/CLI, verify sane `diffPercent` values.

## Open questions / follow-ups (not blocking this spec)

- Should we write an ADR in `furan-design/plan-decisions.md`? This change isn't a reversal — it finishes a half-built feature — but it does formally adopt three engines as supported. Decide separately with the project owner.
- `allowDiffDimensions` should eventually be honored. Track as a v1.1+ TODO.
- VLM as a fourth engine remains in the plan as item #12.
