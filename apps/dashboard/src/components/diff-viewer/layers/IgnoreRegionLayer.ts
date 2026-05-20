import { type Application, Container, Graphics } from "pixi.js";

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
const STYLE = {
  savedActive: {
    fill: 0xff0000,
    fillAlpha: 0.18,
    stroke: 0xcc0000,
    strokeWidth: 2,
  },
  /** Purple variant of savedActive used for `kind: "dynamic-text"` regions
   * so reviewers can visually distinguish ignore from dynamic-text regions
   * at a glance. */
  savedActiveDynamicText: {
    fill: 0x9333ea,
    fillAlpha: 0.15,
    stroke: 0x7e22ce,
    strokeWidth: 2,
  },
  savedInactive: {
    fill: 0x666666,
    fillAlpha: 0.12,
    stroke: 0x666666,
    strokeWidth: 1,
  },
  draft: { fill: 0x000000, fillAlpha: 0, stroke: 0xffcc00, strokeWidth: 2 },
  /** Purple-stroke draft for dynamic-text. Same alpha/fill as `draft` but
   * stroke color is the lighter purple from the saved variant. */
  draftDynamicText: {
    fill: 0x000000,
    fillAlpha: 0,
    stroke: 0xa855f7,
    strokeWidth: 2,
  },
} as const;

const SELECTED_STROKE_WIDTH = 4;
const MARKED_STRIKE_COLOR = 0xff0000;
const MARKED_STRIKE_WIDTH = 3;

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
  /** Currently selected region id (rendered with thicker stroke). */
  selectedIgnoreId: string | null;
  /** Only render regions matching this viewport (or regions with no viewport). */
  viewport: string;
  /**
   * Click handler invoked when the user pointer-up's inside a region.
   * Receives the region id. Inactive-scope regions are NOT clickable
   * (the caller doesn't even register them in the hitmap).
   */
  onSelect: (id: string) => void;
}

/**
 * Mounts a pixi Container holding one Graphics rect per visible region.
 * Returns the container so the caller can detach + replace it without
 * touching the rest of the stage tree.
 */
export function mountIgnoreRegionLayer(
  app: Application,
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

  // Active scope's saved regions: red. Selectable when editing.
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
      style:
        r.kind === "dynamic-text"
          ? STYLE.savedActiveDynamicText
          : STYLE.savedActive,
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
        style:
          r.kind === "dynamic-text"
            ? STYLE.savedActiveDynamicText
            : STYLE.savedActive,
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
        style: r.kind === "dynamic-text" ? STYLE.draftDynamicText : STYLE.draft,
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
    const p = it.paddingPx;
    const x = it.x - p;
    const y = it.y - p;
    const w = it.width + 2 * p;
    const h = it.height + 2 * p;
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
        .rect(it.x, it.y, it.width, it.height)
        .stroke({ color: it.style.stroke, width: 1, alpha: 0.4 });
      container.addChild(inner);
    }
  }

  app.stage.addChild(container);
  return container;
}
