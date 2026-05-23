"use client";

import type { Application, Container, Sprite } from "pixi.js";

import { ZOOM_STEP, useViewerStore } from "./useViewerStore";
import { fitWorldToCanvas, type ViewTransform } from "./world-fit";

/**
 * Attach wheel-zoom + middle-mouse-pan listeners to a Pixi canvas. Returns
 * a teardown function. Pulls actions from the zustand store directly
 * (instead of accepting them as args) so the same wiring works for any
 * canvas in the viewer without needing per-pane prop drilling.
 *
 * Wheel zoom is "trackpad/mouse-pinch" style — no modifier required, since
 * the canvas is a dedicated review surface and hijacking page scroll over
 * it is the expected behavior. We `preventDefault` so the page doesn't
 * scroll behind the canvas; the listener is attached with
 * `{ passive: false }` to make that legal.
 *
 * Pan is middle-mouse drag OR primary-button drag when the viewer is NOT
 * in ignore-edit mode (primary-button drag is reserved for region drawing
 * during edit). Space-bar pan would require a global keydown tracker;
 * deferred — middle-mouse already covers the "pan while editing" case.
 */
export function attachCanvasViewControl(canvas: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasSize = { width: rect.width, height: rect.height };
    // deltaY > 0 = wheel toward user = zoom out; matches Google Maps,
    // Figma, every map-style viewer.
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    useViewerStore.getState().zoomAt(factor, anchor, canvasSize);
  };

  let panning = false;
  let lastX = 0;
  let lastY = 0;
  // Track which button started the pan so we can ignore the matching
  // pointerup from a different button. (Primary-button pan races with
  // the IgnoreRegionLayer's drag-draw on the candidate pane; we only
  // accept primary-button pan when edit mode is off.)
  let panButton: number | null = null;

  const onPointerDown = (e: PointerEvent) => {
    const editMode = useViewerStore.getState().ignoreEditMode;
    const isMiddle = e.button === 1;
    const isPrimary = e.button === 0;
    if (!isMiddle && !(isPrimary && editMode === "off")) return;
    panning = true;
    panButton = e.button;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    // Middle-mouse default in browsers is the autoscroll cursor — kill it.
    if (isMiddle) e.preventDefault();
    canvas.style.cursor = "grabbing";
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    useViewerStore.getState().panBy(dx, dy);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!panning || e.button !== panButton) return;
    panning = false;
    panButton = null;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = "";
  };

  const onPointerCancel = () => {
    panning = false;
    panButton = null;
    canvas.style.cursor = "";
  };

  // Suppress the OS context menu on middle/right click so users can pan
  // without hitting "Print" or "Inspect."
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}

/**
 * Re-apply the world transform with the current zoom/pan state. Read
 * from a ref so the call is cheap on every store update — no React
 * reconciliation, just one matrix update per pane.
 */
export function applyViewToPane(
  app: Application | null,
  world: Container | null,
  sprite: Sprite | null,
  view: ViewTransform,
): void {
  if (!app || !world || !sprite) return;
  fitWorldToCanvas(
    app,
    world,
    sprite.texture.width,
    sprite.texture.height,
    view,
  );
}
