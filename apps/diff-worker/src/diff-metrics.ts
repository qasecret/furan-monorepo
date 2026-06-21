import { Counter, Histogram, type Registry } from "prom-client";

/**
 * L1 latency histogram for the diff pipeline, keyed by engine.
 *
 * Why this exists: ADR-030 introduced selectable L1 backends (odiff,
 * pixelmatch, looks_same). odiff shells out to a native binary;
 * pixelmatch + pngjs runs in-process and decodes/encodes PNGs
 * synchronously. The risk note (R(new)-C) called out a 3× p95
 * regression on non-odiff engines as the action threshold — but that's
 * unobservable without engine-labelled latencies. This metric closes
 * the loop.
 *
 * Buckets cover the realistic range: ~50 ms for odiff on a small
 * thumbnail through several seconds for pixelmatch on a 2560×1440
 * capture. Default histogram buckets (5 ms..10 s, 1.5× spacing) would
 * be denser at the low end than useful here.
 *
 * Labels:
 *   engine — "odiff" | "pixelmatch" | "looks_same"; bounded by the
 *     image_comparison enum, so cardinality is fixed at 3 (+ VLM if
 *     ADR-028 reverses).
 *
 * `project_id` is NOT included as a label here. Adding it would push
 * cardinality into top-N-controlled territory per
 * ops-observability.md §3.1 ("Cardinality discipline"); the operator
 * cares about p95-per-engine across the deployment, not per project.
 * A separate recording rule can add project granularity if needed.
 */
export interface DiffMetrics {
  l1Duration: Histogram<"engine">;
  dynamicTextOcrDuration: Histogram<string>;
  dynamicTextMatch: Counter<"outcome">;
  regionResolution: Counter<"outcome">;
  /**
   * Outcome of resolving an axe-core violation's CSS target to a real
   * bbox via the candidate DOM + element-map sidecar. Counts
   * independently from `regionResolution`; the consumer is
   * `axe-bbox-resolver.ts`, the producer is the handler's
   * post-runAxe pipeline.
   *
   * Outcomes:
   *   - `resolved` — exact selector hit on the violating element
   *   - `resolved_ancestor` — ancestor walk found a containing element
   *   - `selector_miss` — no ancestor in map, or querySelector found nothing
   *   - `dom_unparseable` — jsdom threw on parse
   *   - `no_target` — region had no axeTarget (defensive — axe-core
   *     always supplies one in current versions)
   */
  axeResolution: Counter<"outcome">;
  /**
   * Outcome of the L1 pixel-displacement pre-alignment pass.
   * The pass runs unconditionally per checkpoint (so the outcomes
   * sum to total checkpoints), gated internally on
   * `CheckpointOptions.ignoreDisplacements`.
   *
   * Outcomes:
   *   - `applied` — flag on, detected within caps, alignment used
   *   - `low_confidence` — flag on, peak/mean below 0.05 threshold
   *   - `shift_capped` — flag on, |dx| > 50 OR |dy| > 200
   *   - `skipped` — flag off (the dominant counter; operators can
   *     compute "% of checkpoints with flag on" from this)
   */
  l1Displacement: Counter<"outcome">;
  /**
   * Per-cluster outcome of the deterministic Layout suppression pass
   * (ADR-053). One increment per L1 pixel cluster on a `matchLevel="Layout"`
   * checkpoint. The pass/fail gate stays deterministic; this only observes it.
   *
   * Outcomes (the cluster's verdict reason):
   *   - `stable_element` — suppressed: cluster sits in an unchanged element
   *   - `moved_or_resized` — kept: the containing element's bbox changed
   *   - `absent_in_baseline` — kept: element has no baseline counterpart
   *   - `orphan_no_container` — kept: cluster inside no mapped element
   *   - `cluster_cap_uncertain` — kept: L1 cluster cap hit, can't prove a pass
   *   - `degraded_no_map` — kept: an element map was missing → degraded to Strict
   */
  layoutResolution: Counter<"outcome">;
}

export function createDiffMetrics(registry: Registry): DiffMetrics {
  return {
    l1Duration: new Histogram({
      name: "furan_diff_l1_duration_seconds",
      help: "Wall-clock duration of the L1 (pixel) diff stage, labelled by engine",
      labelNames: ["engine"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [registry],
    }),
    dynamicTextOcrDuration: new Histogram({
      name: "furan_dynamic_text_ocr_duration_seconds",
      help: "Wall-clock duration of one OCR pass on one dynamic-text region",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [registry],
    }),
    dynamicTextMatch: new Counter({
      name: "furan_dynamic_text_match_total",
      help: "Dynamic-text regex evaluations",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    regionResolution: new Counter({
      name: "furan_diff_region_resolution_total",
      help: "Outcome of resolving an ignore region's CSS selector against the candidate's element-map sidecar",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    axeResolution: new Counter({
      name: "furan_diff_axe_region_resolution_total",
      help: "Outcome of resolving an axe-core violation's CSS target to an element-map bbox",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    l1Displacement: new Counter({
      name: "furan_diff_l1_displacement_total",
      help: "Outcome of the L1 pixel-displacement pre-alignment pass",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    layoutResolution: new Counter({
      name: "furan_layout_resolution_total",
      help: "Per-cluster outcome of the deterministic Layout match-level suppression pass",
      labelNames: ["outcome"],
      registers: [registry],
    }),
  };
}
