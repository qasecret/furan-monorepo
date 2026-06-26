import {
  type Container as PixiContainer,
  Container,
  Graphics,
  Text,
} from "pixi.js";

import type { Bbox } from "../region-resize";
import { handlePoints, HANDLES } from "../region-resize";
import type {
  DraftIgnoreArea,
  IgnoreArea,
  IgnoreEditMode,
} from "../useViewerStore";

/**
 * Render styles for the four region states. Saved-active = solid red,
 * saved-inactive = gray (read-only when editing a different scope),
 * draft = yellow stroke / no fill, marked-for-deletion = strikethrough
 * diagonal overlay. Selected = 4px stroke width.
 *
 * Colors are chosen for visibility over white/varied images per ADR-031;
 * inactive-scope uses a lower alpha so it stays clearly subordinate.
 * (Pixi v8 Graphics.stroke has no native dash support; if dashed strokes
 * become a UX requirement, we'd implement them by drawing segmented
 * line pieces.)
 */
/**
 * Per-kind color palette. One entry per `RegionKind`. Colors chosen for
 * visibility over varied screenshot content and rough conventional mapping:
 *   ignore       → red    (loud "skip this")
 *   dynamic-text → purple (existing, conditional mask)
 *   strict       → green  (positive constraint, "must match")
 *   layout       → blue   (structural intent)
 *   content      → orange (text/value intent)
 *
 * Saved-active = solid fill + 2px stroke; draft = translucent fill
 * (same kind color at ~0.10 alpha) + 2px stroke, so the drag-to-draw
 * preview is visible against the candidate image while staying clearly
 * subordinate to saved regions. Selected regions use a 4px stroke
 * regardless. Inactive-scope regions render gray across all kinds —
 * the gray IS the "you can't edit me here" signal, not the kind.
 */
type StyleEntry = {
  fill: number;
  fillAlpha: number;
  stroke: number;
  strokeWidth: number;
};
type KindStyle = { saved: StyleEntry; draft: StyleEntry };
const KIND_STYLES: Record<
  "ignore" | "dynamic-text" | "strict" | "layout" | "content",
  KindStyle
> = {
  ignore: {
    saved: {
      fill: 0xff0000,
      fillAlpha: 0.18,
      stroke: 0xcc0000,
      strokeWidth: 2,
    },
    draft: { fill: 0xff0000, fillAlpha: 0.1, stroke: 0xffcc00, strokeWidth: 2 },
  },
  "dynamic-text": {
    saved: {
      fill: 0x9333ea,
      fillAlpha: 0.15,
      stroke: 0x7e22ce,
      strokeWidth: 2,
    },
    draft: { fill: 0x9333ea, fillAlpha: 0.1, stroke: 0xa855f7, strokeWidth: 2 },
  },
  strict: {
    saved: {
      fill: 0x16a34a,
      fillAlpha: 0.12,
      stroke: 0x15803d,
      strokeWidth: 2,
    },
    draft: { fill: 0x16a34a, fillAlpha: 0.1, stroke: 0x22c55e, strokeWidth: 2 },
  },
  layout: {
    saved: {
      fill: 0x2563eb,
      fillAlpha: 0.13,
      stroke: 0x1d4ed8,
      strokeWidth: 2,
    },
    draft: { fill: 0x2563eb, fillAlpha: 0.1, stroke: 0x3b82f6, strokeWidth: 2 },
  },
  content: {
    saved: {
      fill: 0xea580c,
      fillAlpha: 0.14,
      stroke: 0xc2410c,
      strokeWidth: 2,
    },
    draft: { fill: 0xea580c, fillAlpha: 0.1, stroke: 0xf97316, strokeWidth: 2 },
  },
};

const STYLE = {
  savedInactive: {
    fill: 0x666666,
    fillAlpha: 0.12,
    stroke: 0x666666,
    strokeWidth: 1,
  },
} as const;

const SELECTED_STROKE_WIDTH = 4;
const MARKED_STRIKE_COLOR = 0xff0000;
const MARKED_STRIKE_WIDTH = 3;

// Resize-handle + readout sizes are SCREEN pixels; divided by the world scale
// at draw time so they stay constant on zoom (the layer is in image space).
const HANDLE_PX = 9;
const READOUT_FONT_PX = 12;
const READOUT_PAD_PX = 5;
const READOUT_GAP_PX = 6;

/** White grab-squares at the 8 handle points of the selected region. */
function drawResizeHandles(
  container: Container,
  b: Bbox,
  strokeColor: number,
  scale: number,
): void {
  const s = Math.max(scale, 1e-6);
  const hs = HANDLE_PX / s;
  const border = Math.max(1 / s, 0.5);
  const pts = handlePoints(b);
  for (const handle of HANDLES) {
    const pt = pts[handle];
    const g = new Graphics();
    g.rect(pt.x - hs / 2, pt.y - hs / 2, hs, hs)
      .fill({ color: 0xffffff, alpha: 1 })
      .stroke({ color: strokeColor, width: border, alpha: 1 });
    container.addChild(g);
  }
}

/** Floating "X .. Y .. W .. H .." chip above the selected region. */
function drawReadout(container: Container, b: Bbox, scale: number): void {
  const s = Math.max(scale, 1e-6);
  const pad = READOUT_PAD_PX / s;
  const gap = READOUT_GAP_PX / s;
  const label =
    `X ${Math.round(b.x)}   Y ${Math.round(b.y)}` +
    `   W ${Math.round(b.width)}   H ${Math.round(b.height)}`;
  const text = new Text({
    text: label,
    style: {
      fontFamily: "monospace",
      fontSize: READOUT_FONT_PX / s,
      fill: 0x1f2937,
    },
  });
  const boxW = text.width + pad * 2;
  const boxH = text.height + pad * 2;
  // Sit above the top-left; if that clips the image top, drop below the box.
  const boxX = b.x;
  const boxY = b.y - gap - boxH >= 0 ? b.y - gap - boxH : b.y + b.height + gap;
  const bg = new Graphics();
  bg.rect(boxX, boxY, boxW, boxH)
    .fill({ color: 0xffffff, alpha: 0.92 })
    .stroke({ color: 0xd1d5db, width: Math.max(1 / s, 0.5), alpha: 1 });
  container.addChild(bg);
  text.x = boxX + pad;
  text.y = boxY + pad;
  container.addChild(text);
}

interface MountInput {
  /** The active edit scope ("off" = read-only render of all regions). */
  editMode: IgnoreEditMode;
  /** Saved regions for the run; hydrated from runs.getById.ignoreAreas. */
  savedRunIgnoreAreas: IgnoreArea[];
  /** Saved regions for the variation; from runs.getById.variationIgnoreAreas. */
  savedVariationIgnoreAreas: IgnoreArea[];
  /** Unsaved drafts created by drag-to-draw. */
  draftIgnoreAreas: DraftIgnoreArea[];
  /** Saved regions flagged for deletion (rendered with strikethrough). */
  markedForDeletion: Set<string>;
  /** Currently selected region id (rendered with thicker stroke + handles). */
  selectedIgnoreId: string | null;
  /**
   * Live geometry edits (mouse resize / move) for saved regions, keyed by id.
   * Drafts carry their edited bbox directly; saved regions read through here.
   */
  geometryOverrides: ReadonlyMap<string, Bbox>;
  /**
   * World (image→screen) scale, so resize handles + the X/Y/W/H readout stay
   * a roughly constant SCREEN size instead of scaling with zoom. Caller passes
   * the pixi world's current scale.x; the layer re-mounts on zoom change.
   */
  scale: number;
  /** Only render regions matching this viewport (or regions with no viewport). */
  viewport: string;
  /**
   * Click handler invoked when the user pointer-up's inside a region.
   * Receives the region id. Inactive-scope regions are NOT clickable
   * (the caller doesn't even register them in the hitmap).
   */
  onSelect: (id: string) => void;
  /**
   * Optional "pick element" hover preview — drawn as a translucent
   * yellow outline so the user can see exactly which element they'd
   * snap to before clicking. Cleared when the user moves off any
   * element. Non-interactive (no pointer events).
   */
  pickPreviewBbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

/**
 * Mounts a pixi Container holding one Graphics rect per visible region.
 * Returns the container so the caller can detach + replace it without
 * touching the rest of the stage tree.
 */
export function mountIgnoreRegionLayer(
  parent: PixiContainer,
  input: MountInput,
): Container {
  const container = new Container();

  type ItemStyle = {
    fill: number;
    fillAlpha: number;
    stroke: number;
    strokeWidth: number;
  };
  type Item = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    paddingPx: number;
    kind: IgnoreArea["kind"];
    style: ItemStyle;
    selectable: boolean;
    marked: boolean;
  };
  const items: Item[] = [];

  const viewportMatches = (rv: string): boolean => !rv || rv === input.viewport;

  // Active scope's saved regions: kind-colored. Selectable when editing.
  const activeSaved =
    input.editMode === "variation"
      ? input.savedVariationIgnoreAreas
      : input.savedRunIgnoreAreas;
  for (const r of activeSaved) {
    if (!viewportMatches(r.viewport)) continue;
    items.push({
      id: r.id,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      paddingPx: r.paddingPx ?? 0,
      kind: r.kind,
      style: KIND_STYLES[r.kind].saved,
      selectable: input.editMode !== "off",
      marked: input.markedForDeletion.has(r.id),
    });
  }

  // Inactive scope's saved regions: gray, never selectable.
  if (input.editMode !== "off") {
    const inactiveSaved =
      input.editMode === "variation"
        ? input.savedRunIgnoreAreas
        : input.savedVariationIgnoreAreas;
    for (const r of inactiveSaved) {
      if (!viewportMatches(r.viewport)) continue;
      items.push({
        id: r.id,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        paddingPx: r.paddingPx ?? 0,
        kind: r.kind,
        // Inactive scope keeps `savedInactive` regardless of kind: this is a
        // read-only render of the off-scope, and the gray styling is the
        // load-bearing signal for "you can't edit me here".
        style: STYLE.savedInactive,
        selectable: false,
        marked: false,
      });
    }
  } else {
    // edit-off: render BOTH saved sources as active (the user can't edit
    // them, but the layer still surfaces what's there).
    for (const r of input.savedVariationIgnoreAreas) {
      if (!viewportMatches(r.viewport)) continue;
      items.push({
        id: r.id,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        paddingPx: r.paddingPx ?? 0,
        kind: r.kind,
        style: KIND_STYLES[r.kind].saved,
        selectable: false,
        marked: false,
      });
    }
  }

  // Drafts: only when edit mode is on.
  if (input.editMode !== "off") {
    for (const r of input.draftIgnoreAreas) {
      items.push({
        id: r.id,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        paddingPx: r.paddingPx ?? 0,
        kind: r.kind,
        style: KIND_STYLES[r.kind].draft,
        selectable: true,
        marked: false,
      });
    }
  }

  for (const it of items) {
    const isSelected = input.selectedIgnoreId === it.id;
    const strokeWidth = isSelected
      ? SELECTED_STROKE_WIDTH
      : it.style.strokeWidth;
    // Live geometry (mouse resize / move): drafts mutate in place; saved
    // regions read the override. Falls back to the item's own bbox.
    const eff = input.geometryOverrides.get(it.id);
    const bx = eff?.x ?? it.x;
    const by = eff?.y ?? it.y;
    const bw = eff?.width ?? it.width;
    const bh = eff?.height ?? it.height;
    const p = it.paddingPx;
    const x = bx - p;
    const y = by - p;
    const w = bw + 2 * p;
    const h = bh + 2 * p;
    const g = new Graphics();
    g.rect(x, y, w, h)
      .fill({ color: it.style.fill, alpha: it.style.fillAlpha })
      .stroke({ color: it.style.stroke, width: strokeWidth, alpha: 0.95 });
    if (it.marked) {
      g.moveTo(x, y)
        .lineTo(x + w, y + h)
        .stroke({ color: MARKED_STRIKE_COLOR, width: MARKED_STRIKE_WIDTH });
    }
    if (it.selectable) {
      g.eventMode = "static";
      g.cursor = "pointer";
      g.on("pointertap", () => input.onSelect(it.id));
    }
    container.addChild(g);

    if (p > 0) {
      // Faint inner rect at the drag-drawn bbox so users can see what
      // they originally drew vs. the padded extent that's actually
      // masked. Same stroke color, low alpha, thin stroke.
      const inner = new Graphics();
      inner
        .rect(bx, by, bw, bh)
        .stroke({ color: it.style.stroke, width: 1, alpha: 0.4 });
      container.addChild(inner);
    }

    // Resize handles + X/Y/W/H readout on the selected, editable region —
    // drawn on the UNPADDED bbox (the geometry the user actually edits).
    if (isSelected && it.selectable) {
      drawResizeHandles(
        container,
        { x: bx, y: by, width: bw, height: bh },
        it.style.stroke,
        input.scale,
      );
      drawReadout(
        container,
        { x: bx, y: by, width: bw, height: bh },
        input.scale,
      );
    }
  }

  // Pick-mode preview: rendered LAST so it sits above existing regions
  // (saved + drafts) — the user is mid-pick and needs to clearly see
  // what the next click will create, even if it overlaps an existing
  // region. Stroke matches the draft yellow with a brighter alpha so
  // it reads as "this is what's about to land."
  if (input.pickPreviewBbox) {
    const p = input.pickPreviewBbox;
    const preview = new Graphics();
    preview
      .rect(p.x, p.y, p.width, p.height)
      .fill({ color: 0xffcc00, alpha: 0.12 })
      .stroke({ color: 0xffcc00, width: 2, alpha: 1 });
    container.addChild(preview);
  }

  parent.addChild(container);
  return container;
}
