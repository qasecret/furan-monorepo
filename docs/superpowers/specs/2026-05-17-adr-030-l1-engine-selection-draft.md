# ADR-030 Draft + arch-backend.md Update — for `furan-design/` mirroring

This file holds drafts the maintainer should mirror into the separate `furan-design` repo. The local checkout at `./furan-design/` is gitignored and per CLAUDE.md not modifiable from this repo; this draft lands in `furan-monorepo` so it ships with PR #39 for review.

After review, copy the two sections below into:

- `furan-design/plan-decisions.md` (append ADR-030 to end of ADR list)
- `furan-design/arch-backend.md` (edit §4.5 per the diff shown)

Reason these drafts exist: PR #39 implemented selectable L1 engines without first going through the `contexts/ai-workflow-rules.md` "implement against these specs" flow. Pixelmatch was specced as a fallback contingency only (phase-2-diff-design.md:801) and looks-same wasn't specced at all. The schema `image_comparison` column existed but was unused. This ADR retroactively authorizes the v1.0 scope expansion.

---

## Section 1 — ADR-030 (to append in `furan-design/plan-decisions.md`)

```markdown
## ADR-030 — Activate `projects.image_comparison` as user-selectable L1 backend; add pixelmatch and looks-same alongside odiff

**Date:** 2026-05-17 · **Status:** Accepted · **Supersedes:** — · **Amends:** [Phase 2 design spec](specs/2026-05-16-phase-2-diff-design.md) (extends L1 backend choice from a fallback contingency to a per-project setting)

### Context

The `image_comparison` enum (`pixelmatch | looks_same | odiff`) and `image_comparison_config` text column were added to the `projects` table in Phase 1.B's initial schema ([plan-roadmap.md §7 changelog 2026-05-16](plan-roadmap.md)). The Phase 2 design ([specs/2026-05-16-phase-2-diff-design.md §1](specs/2026-05-16-phase-2-diff-design.md), [arch-backend.md §4.5](arch-backend.md#45-workers--queue)) chose **odiff** as the L1 backend on performance grounds (~10× faster than pixelmatch, single binary per platform). Pixelmatch appeared in the Phase 2 spec only as a **fallback contingency** if `odiff-bin` prebuilt binaries failed to install (P2-R1, [specs/2026-05-16-phase-2-diff-design.md:801](specs/2026-05-16-phase-2-diff-design.md)). Looks-same did not appear in any design doc.

In practice, `packages/diff-engine` shipped with `runL1` hard-coded to odiff and the diff-worker never read `project.imageComparison` or `project.imageComparisonConfig` — every project ran odiff regardless of stored setting. A 2026-05-17 competitive comparison against Visual Regression Tracker (VRT) surfaced two observations:

1. **The schema field was load-bearing in design but inert in code.** Every new project gets `imageComparison: "pixelmatch"` (the schema default) yet odiff runs. Reading `project.imageComparison` in the worker is the minimum fix.
2. **Backend choice is one of the few config knobs users actually want.** VRT exposes four (pixelmatch / looks-same / odiff / VLM) per project. Lost Pixel pins one. Pixelmatch is the de-facto JS-ecosystem default (Percy, Chromatic, jest-image-snapshot are pixelmatch-derived). Letting users pick the backend that matches their existing test-suite habits lowers migration friction.

§7.1 of [plan-roadmap.md](plan-roadmap.md) does not list "selectable comparison engines" as a deferred v1.1+ item. The change is therefore not a forbidden v1.1+ pull-forward under [contexts/ai-workflow-rules.md](contexts/ai-workflow-rules.md), but the absence of an authorizing ADR meant the implementation in PR #39 (furan-monorepo) preceded the design decision rather than following it.

### Decision

Per-project selectable L1 backend is in v1.0 scope.

- The L1 dispatcher (`packages/diff-engine/src/l1.ts`) switches on `ProjectDiffConfig.engine` (typed `"pixelmatch" | "looks_same" | "odiff"`, matching the `image_comparison` enum) to one of three sibling implementations: `l1-odiff.ts` (existing logic moved verbatim, antialiasing now driven by config), `l1-pixelmatch.ts` (pixelmatch + pngjs), `l1-looks-same.ts` (looks-same). The switch is exhaustive via TypeScript's `never` check.
- Pixelmatch and looks-same don't natively support arbitrary ignore regions; a shared `applyIgnoreMask()` helper paints solid-black RGBA rectangles over both input buffers before comparison. odiff continues to use its native `ignoreRegions`.
- `ProjectDiffConfig.engine` and `.engineConfig` are required (compile-time fail-fast on callers that forget to pass them). `engineConfig` is a Zod-validated `{ threshold, ignoreAntialiasing, allowDiffDimensions }` shape persisted as JSON in `projects.image_comparison_config`. Malformed JSON falls back to `DEFAULT_ENGINE_CONFIG` with a warn log carrying `projectId`.
- **Default flips from `pixelmatch` to `odiff`** at the schema level. A data migration rewrites any existing `pixelmatch` rows to `odiff` so live projects preserve current behavior (everyone has been running odiff regardless of stored value).
- `allowDiffDimensions` is plumbed in the type but currently a no-op (documented limitation).
- VLM as a fourth engine remains deferred per [ADR-028](#adr-028--defer-vlm-differentiator-to-v11-v10-ships-on-install--dogfood-polish).

### Consequences

- **Phase 2 spec amended.** [specs/2026-05-16-phase-2-diff-design.md §1](specs/2026-05-16-phase-2-diff-design.md) "_odiff-bin for L1_" is extended to "_per-project L1 backend (default odiff)_". P2-R1's fallback rationale is preserved: pixelmatch was already vetted as an emergency contingency, so promoting it to a user-selectable option carries no incremental supply-chain risk.
- **`arch-backend.md` §4.5 updated.** "_runs L1 (odiff) and L2 (diff-dom)_" → "_runs L1 (per-project: odiff, pixelmatch, looks-same) and L2 (diff-dom)_".
- **No new tables or columns.** Implementation is pure schema-default change + a data migration. `image_comparison` and `image_comparison_config` were already in [arch-backend.md §4.2](arch-backend.md#42-schema-drizzle-packagesdbsrcschemats).
- **Cost-discipline (T5) preserved.** L1→L2 short-circuit on `projects.diff_threshold` is unchanged. Engine selection runs entirely inside L1; the L1→L2 gate is engine-agnostic.
- **Project-scoping (T1) preserved.** No new business entities; the engine choice is a property of the existing `projects` row.
- **Observability tagging (T2) preserved.** `parseEngineConfig` warn logs include `projectId`; engine choice flows through existing log/metric tags on diff jobs.
- **Self-host parity (T6) preserved.** All three engines run in-process; no new infra.

**Risks introduced:**

- **R(new)-C: pixelmatch/looks-same in-process CPU cost.** odiff shells out to a native binary; pixelmatch + pngjs runs in-process and decodes/encodes PNGs synchronously. For 2560×1440 captures (~3.7M pixels) the throughput is acceptable on a worker box but not benchmarked. **Mitigation:** odiff stays default; first production install monitors p95 worker `durationMs.l1` per engine. Threshold for action: 3× regression on p95 for projects using pixelmatch/looks-same.
- **R(new)-D: looks-same `pixelMismatchCount` is approximate.** looks-same returns cluster bounding boxes, not exact mismatch counts. `runL1LooksSame` reports the bbox-area sum, which overestimates. **Mitigation:** documented in JSDoc; downstream UI (region count display) inflates only for looks-same projects.
- **R(new)-E: `allowDiffDimensions` is plumbed but inert.** Field exists in schema, type, and Zod schema, but no engine honors it; all three short-circuit on size mismatch. **Mitigation:** documented limitation. v1.1+ work item: either honor it or remove from the config shape.

### Trigger to revisit

This ADR is revisited if pixelmatch/looks-same throughput regression on representative captures exceeds the 3× threshold above, or if user feedback indicates the existing three-engine choice is insufficient (the obvious extension is VLM, which has its own re-entry path via [ADR-028](#adr-028--defer-vlm-differentiator-to-v11-v10-ships-on-install--dogfood-polish)).

### Cascading doc edits (separate commits)

- [arch-backend.md §4.5](arch-backend.md) workers description (see Section 2 below for the patch)
- [arch-backend.md §6 / §9](arch-backend.md) — no change (T5 preserved, acceptance criteria unchanged)
- [plan-roadmap.md §6 / §7.1](plan-roadmap.md) — no change (item is not on the deferral list; v1.0 scope expansion is captured by this ADR)
- [contexts/progress-tracker.md](contexts/progress-tracker.md) — add change-log entry for 2026-05-17

### Implementation reference

- `furan-monorepo` PR: [#39](https://github.com/qasecret/furan-monorepo/pull/39)
- Spec: `docs/superpowers/specs/2026-05-17-l1-engine-selection-design.md`
- Plan: `docs/superpowers/plans/2026-05-17-l1-engine-selection.md`
- Diff stat: 9 source files, 1 migration, 6 test files, 25/25 unit tests green
```

---

## Section 2 — `arch-backend.md` §4.5 patch (to apply in `furan-design/arch-backend.md`)

Find the existing bullet (around line 184):

```markdown
- **`apps/diff-worker`** — runs L1 (odiff) and L2 (diff-dom). (`VlmJob` enqueue deferred per [ADR-028](plan-decisions.md#adr-028--defer-vlm-differentiator-to-v11-v10-ships-on-install--dogfood-polish).)
```

Replace with:

```markdown
- **`apps/diff-worker`** — runs L1 + L2 (diff-dom). L1 backend is per-project selectable per [ADR-030](plan-decisions.md#adr-030--activate-projectsimage_comparison-as-user-selectable-l1-backend-add-pixelmatch-and-looks-same-alongside-odiff): `image_comparison` enum ∈ {`odiff` (default, native binary), `pixelmatch` (pure JS), `looks_same` (perceptual)}. Engine-specific config in `image_comparison_config` (`{threshold, ignoreAntialiasing, allowDiffDimensions}`, malformed JSON falls back to defaults with a warn log). The L1→L2 gate on `diff_threshold` is engine-agnostic. (`VlmJob` enqueue deferred per [ADR-028](plan-decisions.md#adr-028--defer-vlm-differentiator-to-v11-v10-ships-on-install--dogfood-polish).)
```

---

## Section 3 — `contexts/progress-tracker.md` change-log entry (append to current phase log)

```markdown
- 2026-05-17: **L1 engine selection wired** ([furan-monorepo#39](https://github.com/qasecret/furan-monorepo/pull/39)). `projects.image_comparison` becomes load-bearing: per-project selection between odiff (default, performance), pixelmatch (jest-image-snapshot / Percy ecosystem parity), looks_same (perceptual). Strategy-pattern dispatcher in `packages/diff-engine/src/l1.ts` with exhaustive switch; ignoreAreas pre-masked for pixelmatch/looks-same via shared `applyIgnoreMask()`. Schema default flipped from `pixelmatch` to `odiff` + data migration rewrites existing `pixelmatch` rows so live projects preserve current behavior. tRPC `projects.update` accepts the field; dashboard project-settings page exposes a Select. New ADR-030 retroactively authorizes the v1.0 scope expansion (item not on §7.1 deferral list; no v1.1+ pull-forward). VLM remains deferred per ADR-028. 25/25 diff-engine unit tests green; repo-wide lint/typecheck/build green; integration tests require Postgres+Redis and run in CI.
```
