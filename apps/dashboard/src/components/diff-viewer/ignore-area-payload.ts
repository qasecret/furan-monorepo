import type { DraftIgnoreArea, IgnoreArea } from "./useViewerStore";

/**
 * The wire shape sent to `runs.setIgnoreAreas` / `runs.approve` /
 * `runs.approveCheckpoint`. Mirrors the server's `ignoreRegionElementSchema`.
 */
export interface IgnoreAreaWire {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport: string;
  paddingPx: number;
  kind: IgnoreArea["kind"];
  pattern?: string;
  selector?: string;
  thresholdOverride?: number;
}

/** The viewer-store slices the builder + dirty-check read. */
export interface IgnorePayloadState {
  savedRunIgnoreAreas: IgnoreArea[];
  savedVariationIgnoreAreas: IgnoreArea[];
  draftIgnoreAreas: DraftIgnoreArea[];
  markedForDeletion: ReadonlySet<string>;
  paddingOverrides: ReadonlyMap<string, number>;
  kindOverrides: ReadonlyMap<
    string,
    { kind: IgnoreArea["kind"]; pattern?: string }
  >;
  thresholdOverrides: ReadonlyMap<string, number | undefined>;
  selectorOverrides: ReadonlyMap<string, string | null>;
  geometryOverrides: ReadonlyMap<
    string,
    { x: number; y: number; width: number; height: number }
  >;
}

/**
 * True when the viewer holds unsaved ignore-region edits — drawn drafts,
 * deletions, or per-region overrides. Mirrors the `hasUnsaved` guard in
 * `hydrateSavedIgnoreAreas` so a refetch never clobbers in-progress work, and
 * gates ApprovalBar's approve-flush (only send regions when the user changed
 * them).
 */
export function hasUnsavedIgnoreChanges(s: IgnorePayloadState): boolean {
  return (
    s.draftIgnoreAreas.length > 0 ||
    s.markedForDeletion.size > 0 ||
    s.paddingOverrides.size > 0 ||
    s.kindOverrides.size > 0 ||
    s.thresholdOverrides.size > 0 ||
    s.selectorOverrides.size > 0 ||
    s.geometryOverrides.size > 0
  );
}

/**
 * Build the full ignore-area replacement payload for `scope`: surviving saved
 * regions (deletions removed, per-region overrides applied) followed by freshly
 * drawn drafts. Shared by the toolbar's Save and ApprovalBar's approve-flush so
 * the two can't drift. Extracted VERBATIM from the toolbar's prior inline build.
 */
export function buildIgnoreAreasPayload(
  s: IgnorePayloadState,
  scope: "run" | "variation",
): IgnoreAreaWire[] {
  const activeSaved =
    scope === "variation" ? s.savedVariationIgnoreAreas : s.savedRunIgnoreAreas;
  const survivors = activeSaved
    .filter((r) => !s.markedForDeletion.has(r.id))
    .map((r) => {
      const kindOv = s.kindOverrides.get(r.id);
      const selectorOv = s.selectorOverrides.get(r.id);
      const resolvedSelector =
        selectorOv === null ? undefined : (selectorOv ?? r.selector);
      const effectiveKind = kindOv?.kind ?? r.kind;
      const threshold =
        effectiveKind === "strict"
          ? s.thresholdOverrides.has(r.id)
            ? s.thresholdOverrides.get(r.id)
            : r.thresholdOverride
          : undefined;
      const geo = s.geometryOverrides.get(r.id) ?? r;
      return {
        x: geo.x,
        y: geo.y,
        width: geo.width,
        height: geo.height,
        viewport: r.viewport,
        paddingPx: s.paddingOverrides.get(r.id) ?? r.paddingPx,
        kind: effectiveKind,
        pattern: kindOv ? kindOv.pattern : r.pattern,
        selector: resolvedSelector,
        ...(threshold !== undefined ? { thresholdOverride: threshold } : {}),
      };
    });
  const drafts = s.draftIgnoreAreas.map((r) => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    viewport: r.viewport,
    paddingPx: r.paddingPx,
    kind: r.kind,
    pattern: r.pattern,
    selector: r.selector,
    ...(r.kind === "strict" && r.thresholdOverride !== undefined
      ? { thresholdOverride: r.thresholdOverride }
      : {}),
  }));
  return [...survivors, ...drafts];
}
