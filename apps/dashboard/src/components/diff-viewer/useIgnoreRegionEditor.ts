"use client";

import { useRef, useState } from "react";

import {
  applyHandleResize,
  applyMove,
  HANDLE_CURSOR,
  hitTestHandle,
  isInsideBbox,
  type Bbox,
  type Handle,
} from "./region-resize";
import { findSmallestElementAtPoint } from "./snap-to-element";
import type { ElementBbox, ElementMap } from "./useElementMap";
import {
  selectEffectiveGeometryById,
  useViewerStore,
  type DraftIgnoreArea,
} from "./useViewerStore";
import type { Point, Size } from "./viewer-geometry";

import { randomUuid } from "@/lib/random-uuid";

/**
 * The ignore-region editor's pointer handling, moved out of the old
 * `ViewerCanvas` unchanged: drag-to-draw, the resize handles, the body move,
 * click-to-select (`hitTest`) and pick mode. It works in image pixels, which
 * `toImage` gives it from a pointer (`pointerToImage`, over the world
 * transform); it draws nothing itself.
 */

/** Minimum draw size in image-pixel space (anything smaller is treated as a misclick). */
const MIN_DRAW_PX = 5;
/** Grab radius (screen px) for the resize handles; divided by world scale. */
const HANDLE_HIT_PX = 11;

/** Active resize / move gesture on the selected region (null = none / drawing). */
type RegionDrag =
  | { kind: "resize"; handle: Handle; start: Bbox }
  | { kind: "move"; startPt: { x: number; y: number }; start: Bbox }
  | null;

/** The topmost (last-listed) region containing `point`, or null. */
export function hitTest(
  point: { x: number; y: number },
  regions: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
): string | null {
  // Iterate in reverse so topmost (later-added) regions win.
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]!;
    if (
      point.x >= r.x &&
      point.x <= r.x + r.width &&
      point.y >= r.y &&
      point.y <= r.y + r.height
    ) {
      return r.id;
    }
  }
  return null;
}

type PointerHandler = (e: React.PointerEvent<HTMLDivElement>) => void;

export interface IgnoreRegionEditor {
  /** The editor is open: the overlay takes the pointer. */
  overlayActive: boolean;
  /** Pick mode with an element map to pick from. */
  pickModeActive: boolean;
  /** The element pick mode would take, under the cursor. */
  pickPreview: ElementBbox | null;
  /** Resize arrow over a handle, "move" over the selected body; null: the base cursor. */
  hoverCursor: string | null;
  handlers: {
    onPointerDown: PointerHandler;
    onPointerMove: PointerHandler;
    onPointerUp: PointerHandler;
    onPointerCancel: PointerHandler;
    onPointerLeave: PointerHandler;
  };
}

export function useIgnoreRegionEditor({
  toImage,
  scale,
  bounds,
  elementMap,
}: {
  /** The image pixel under a pointer, or null off the image. */
  toImage: (e: { clientX: number; clientY: number }) => Point | null;
  /** World to canvas scale, so the handles' grab radius is in screen px. */
  scale: number;
  /** The image a moved region stays inside; null: unbounded. */
  bounds: Size | null;
  /** The candidate's element map, for pick mode; null without one. */
  elementMap: ElementMap | null | undefined;
}): IgnoreRegionEditor {
  const ignoreEditMode = useViewerStore((s) => s.ignoreEditMode);
  const savedRunIgnoreAreas = useViewerStore((s) => s.savedRunIgnoreAreas);
  const savedVariationIgnoreAreas = useViewerStore(
    (s) => s.savedVariationIgnoreAreas,
  );
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const viewport = useViewerStore((s) => s.viewport);
  const addDraftRegion = useViewerStore((s) => s.addDraftRegion);
  const setSelectedIgnoreId = useViewerStore((s) => s.setSelectedIgnoreId);
  const setGeometryForSelected = useViewerStore(
    (s) => s.setGeometryForSelected,
  );
  const regionInputMode = useViewerStore((s) => s.regionInputMode);

  // Hovered element under the cursor in pick mode. Kept as state so the
  // ignore-region layer re-renders the preview rect on every hover step.
  const [pickPreview, setPickPreview] = useState<ElementBbox | null>(null);
  // Resize / move gesture, kept in a ref so pointermove reads it synchronously
  // without a re-render per mouse step (geometry is pushed to the store live).
  const dragModeRef = useRef<RegionDrag>(null);
  // Cursor for the overlay while idle-hovering the selected region (resize
  // arrow over a handle, "move" over the body). Null → the base crosshair.
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragCurrent, setDragCurrent] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const overlayActive = ignoreEditMode !== "off";
  const pickModeActive =
    overlayActive && regionInputMode === "pick" && !!elementMap;
  const handleTolerance = HANDLE_HIT_PX / Math.max(scale, 1e-6);

  const onPointerDown: PointerHandler = (e) => {
    if (!overlayActive) return;
    // Non-primary buttons (middle = 1, right = 2) belong to the canvas
    // view-control listener (pan / context-menu suppression). Only
    // primary button is drag-draw.
    if (e.button !== 0) return;
    if (pickModeActive) return; // pick fires on pointerup, not down
    const pt = toImage(e);
    if (!pt) return;
    // Grab a resize handle / the body of the selected region before falling
    // through to drag-to-draw. Read fresh store state for the live geometry.
    if (selectedIgnoreId) {
      const sel = selectEffectiveGeometryById(
        useViewerStore.getState(),
        selectedIgnoreId,
      );
      if (sel) {
        const handle = hitTestHandle(pt, sel, handleTolerance);
        if (handle) {
          dragModeRef.current = { kind: "resize", handle, start: sel };
          (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
          return;
        }
        if (isInsideBbox(pt, sel)) {
          dragModeRef.current = { kind: "move", startPt: pt, start: sel };
          (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    setDragStart(pt);
    setDragCurrent(pt);
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove: PointerHandler = (e) => {
    if (!overlayActive) return;
    const drag = dragModeRef.current;
    if (drag) {
      const pt = toImage(e);
      if (!pt) return;
      if (drag.kind === "resize") {
        setGeometryForSelected(applyHandleResize(drag.handle, drag.start, pt));
      } else {
        setGeometryForSelected(
          applyMove(
            drag.start,
            pt.x - drag.startPt.x,
            pt.y - drag.startPt.y,
            bounds?.w ?? Number.POSITIVE_INFINITY,
            bounds?.h ?? Number.POSITIVE_INFINITY,
          ),
        );
      }
      return;
    }

    // Idle hover feedback: resize arrow over a handle, "move" over the body of
    // the selected region. Only update state when the cursor actually changes.
    let nextCursor: string | null = null;
    if (!pickModeActive && !dragStart && selectedIgnoreId) {
      const hp = toImage(e);
      const sel = hp
        ? selectEffectiveGeometryById(
            useViewerStore.getState(),
            selectedIgnoreId,
          )
        : null;
      if (hp && sel) {
        const handle = hitTestHandle(hp, sel, handleTolerance);
        nextCursor = handle
          ? HANDLE_CURSOR[handle]
          : isInsideBbox(hp, sel)
            ? "move"
            : null;
      }
    }
    if (nextCursor !== hoverCursor) setHoverCursor(nextCursor);

    if (pickModeActive) {
      const pt = toImage(e);
      if (!pt) {
        if (pickPreview) setPickPreview(null);
        return;
      }
      const hit = findSmallestElementAtPoint(pt, elementMap.elements);
      // Only push state when the hovered bbox changes, to keep the
      // IgnoreRegionLayer remount effect from re-running on every
      // sub-pixel mouse step.
      if (!hit) {
        if (pickPreview) setPickPreview(null);
        return;
      }
      const same =
        pickPreview &&
        pickPreview.x === hit.bbox.x &&
        pickPreview.y === hit.bbox.y &&
        pickPreview.width === hit.bbox.width &&
        pickPreview.height === hit.bbox.height;
      if (!same) setPickPreview(hit.bbox);
      return;
    }
    if (!dragStart) return;
    const pt = toImage(e);
    if (!pt) return;
    setDragCurrent(pt);
  };

  const onPointerUp: PointerHandler = (e) => {
    if (!overlayActive) return;
    if (e.button !== 0) return;
    if (dragModeRef.current) {
      // Geometry was pushed to the store live during the drag; just end it.
      dragModeRef.current = null;
      (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
      return;
    }
    if (pickModeActive) {
      const pt = toImage(e);
      if (!pt) return;
      const hit = findSmallestElementAtPoint(pt, elementMap.elements);
      if (!hit) return; // click missed every element — no-op
      const draft: DraftIgnoreArea = {
        id: randomUuid(),
        x: hit.bbox.x,
        y: hit.bbox.y,
        width: hit.bbox.width,
        height: hit.bbox.height,
        viewport,
        paddingPx: 0,
        kind: "ignore",
        // Pre-set the selector so the region anchors to the element
        // immediately — the pick path is a stronger expression of
        // intent than the post-drag snap suggestion.
        selector: hit.selector,
      };
      addDraftRegion(draft);
      setPickPreview(null);
      return;
    }
    if (!dragStart) return;
    const pt = toImage(e) ?? dragCurrent;
    setDragStart(null);
    setDragCurrent(null);
    (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
    if (!pt) return;
    const x = Math.min(dragStart.x, pt.x);
    const y = Math.min(dragStart.y, pt.y);
    const width = Math.abs(pt.x - dragStart.x);
    const height = Math.abs(pt.y - dragStart.y);
    if (width < MIN_DRAW_PX || height < MIN_DRAW_PX) {
      // Treat as a click (not a drag). Hit-test active-scope regions
      // for selection; clicks on empty area deselect.
      const activeSaved =
        ignoreEditMode === "variation"
          ? savedVariationIgnoreAreas
          : savedRunIgnoreAreas;
      const candidates = [
        ...activeSaved.filter((r) => !r.viewport || r.viewport === viewport),
        ...draftIgnoreAreas,
      ];
      const hit = hitTest(dragStart, candidates);
      setSelectedIgnoreId(hit);
      return;
    }
    const draft: DraftIgnoreArea = {
      id: randomUuid(),
      x,
      y,
      width,
      height,
      viewport,
      paddingPx: 0,
      kind: "ignore",
    };
    addDraftRegion(draft);
  };

  const onPointerCancel: PointerHandler = () => {
    if (!overlayActive) return;
    dragModeRef.current = null;
    setDragStart(null);
    setDragCurrent(null);
    if (pickPreview) setPickPreview(null);
  };

  const onPointerLeave: PointerHandler = () => {
    if (pickPreview) setPickPreview(null);
    if (hoverCursor) setHoverCursor(null);
  };

  return {
    overlayActive,
    pickModeActive,
    pickPreview,
    hoverCursor,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
    },
  };
}
