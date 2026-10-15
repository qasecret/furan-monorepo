"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { tinykeys } from "tinykeys";

import { getClipboardRegion, setClipboardRegion } from "./region-clipboard";
import {
  selectEffectiveRegion,
  useViewerStore,
  ZOOM_STEP,
  type ViewerMode,
} from "./useViewerStore";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";

const MODES: ViewerMode[] = ["side-by-side", "overlay", "difference"];

interface ShortcutOptions {
  viewports: string[];
  /**
   * Project id — keys the per-project region clipboard for the
   * `$mod+C` / `$mod+V` shortcuts. Optional so existing callers that
   * predate region copy/paste still compile; when empty the handlers
   * short-circuit (no copy/paste happens).
   */
  projectId?: string;
  onApprove?: () => void; // T11 supplies these
  onReject?: () => void;
  /** ⌘Z / Ctrl+Z: takes back the newest review action. */
  onUndo?: () => void;
  onHelpToggle?: () => void;
  onNextDiff?: () => void;
  onPrevDiff?: () => void;
  /**
   * Step (checkpoint) navigation for ←/→ — the reference TestStep binds the
   * arrows to "navigate" between the run's own steps.
   */
  onPrevStep?: () => void;
  onNextStep?: () => void;
  /**
   * J / K: the next / previous step that still needs a reviewer, in the
   * review loop's order (across the runs of the batch, inside the filter).
   * Absent when the loop is off (the run did not load).
   */
  onNextPending?: () => void;
  onPrevPending?: () => void;
  /**
   * Esc, when something on the page takes it in place of the viewer's own
   * (leave the ignore editor, clear the selection): the review loop's done
   * card, which goes back to the batch wherever focus is.
   */
  onEscape?: () => void;
}

// <input> types that take no typed text — single-key shortcuts still apply
// while one of these has focus (e.g. after clicking a checkbox).
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

// Widgets that consume bare keys themselves: menu / listbox typeahead
// (pressing "A" in the open More menu jumps to "Approve all"), and dialogs
// layered over the viewer.
const KEYBOARD_OWNER_ROLES =
  '[role="menu"],[role="menubar"],[role="listbox"],[role="dialog"],[role="alertdialog"]';

// A dialog that owns the bare keys but lets ⌘Z through to the viewer: the
// review loop's done card (BatchDoneCard), where undoing the decision that
// brought it up brings the step back (R20).
const PASSES_UNDO = "[data-passes-undo]";

function isTypingInInput(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "INPUT") {
    return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  // `closest` also covers focus inside a nested editable region (and jsdom,
  // which doesn't implement `isContentEditable`).
  if (
    el.isContentEditable ||
    el.closest('[contenteditable]:not([contenteditable="false"])')
  ) {
    return true;
  }
  return false;
}

/**
 * True when this keystroke belongs to something else: a text field or
 * select has focus, focus is inside a menu / listbox / dialog, or another
 * handler already consumed it. Every viewer shortcut yields in that case —
 * otherwise typing "a" into the PatternEditor approves the run, "/" opens
 * the palette mid-regex, and Backspace deletes the selected region. `undo`
 * (⌘Z) is not owned by a dialog that passes it through.
 */
function keyIsOwnedElsewhere(e: KeyboardEvent, undo = false): boolean {
  if (e.defaultPrevented) return true;
  if (isTypingInInput()) return true;
  if (typeof document === "undefined") return false;
  const owner = document.activeElement?.closest(KEYBOARD_OWNER_ROLES);
  if (!owner) return false;
  return !(undo && owner.matches(PASSES_UNDO));
}

function hasTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0;
}

/**
 * Wires keyboard shortcuts for the DiffViewer.
 *
 * `optsRef` indirection: callbacks (approve/reject/help, step and queue
 * navigation) are read through a ref so the underlying tinykeys binding does
 * not need to be torn down on every parent re-render.
 *
 * `?` is bound both bare and as `Shift+?` because on US-layout the `?`
 * key requires shift; tinykeys matches `key`, which is already `?` once
 * shift is held, but binding both keeps it robust across layouts.
 */
export function useDiffViewerShortcuts(opts: ShortcutOptions) {
  const mode = useViewerStore((s) => s.mode);
  const setMode = useViewerStore((s) => s.setMode);
  const viewport = useViewerStore((s) => s.viewport);
  const setViewport = useViewerStore((s) => s.setViewport);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const bindings: Record<string, (e: KeyboardEvent) => void> = {
      ArrowLeft: () => {
        optsRef.current.onPrevStep?.();
      },
      ArrowRight: () => {
        optsRef.current.onNextStep?.();
      },
      D: () => {
        // Toggle the single-image difference view.
        setMode(mode === "difference" ? "side-by-side" : "difference");
      },
      O: () => {
        const idx = MODES.indexOf(mode);
        const next = MODES[(idx + 1) % MODES.length];
        if (next) setMode(next);
      },
      "[": () => {
        const vps = optsRef.current.viewports;
        if (vps.length === 0) return;
        const i = vps.indexOf(viewport);
        const next = vps[(i - 1 + vps.length) % vps.length] ?? vps[0];
        if (next) setViewport(next);
      },
      "]": () => {
        const vps = optsRef.current.viewports;
        if (vps.length === 0) return;
        const i = vps.indexOf(viewport);
        const next = vps[(i + 1) % vps.length] ?? vps[0];
        if (next) setViewport(next);
      },
      H: () => {
        const s = useViewerStore.getState();
        s.setHighlightActive(!s.highlightActive);
      },
      n: () => {
        optsRef.current.onNextDiff?.();
      },
      p: () => {
        optsRef.current.onPrevDiff?.();
      },
      // Approve / reject ignore auto-repeat: holding the key must not fire
      // a second review action.
      A: (e) => {
        if (e.repeat) return;
        optsRef.current.onApprove?.();
      },
      R: (e) => {
        if (e.repeat) return;
        optsRef.current.onReject?.();
      },
      // `X` is the legacy reject hotkey from the predecessor frontend.
      // Aliased to onReject so power reviewers carrying muscle memory from
      // the old viewer hit the same action without retraining.
      X: (e) => {
        if (e.repeat) return;
        optsRef.current.onReject?.();
      },
      // The review loop. Auto-repeat is ignored too: holding J must not walk
      // the queue one step per repeat.
      J: (e) => {
        if (e.repeat) return;
        optsRef.current.onNextPending?.();
      },
      K: (e) => {
        if (e.repeat) return;
        optsRef.current.onPrevPending?.();
      },
      C: () => {
        const store = useViewerStore.getState();
        store.setCommentPanelOpen(!store.commentPanelOpen);
      },
      "?": () => optsRef.current.onHelpToggle?.(),
      "Shift+?": () => optsRef.current.onHelpToggle?.(),
      // T9: `/` opens the global cmdk command palette. We reach into the
      // zustand store directly so the binding stays decoupled from props.
      "/": () => usePaletteStore.getState().setOpen(true),
      // F14/F15: ignore-region editor shortcuts (ADR-031)
      I: () => {
        const store = useViewerStore.getState();
        if (store.ignoreEditMode === "off") {
          store.setIgnoreEditMode("run");
        } else {
          store.setIgnoreEditMode("off");
        }
      },
      Delete: () => {
        const store = useViewerStore.getState();
        if (store.ignoreEditMode !== "off") {
          store.deleteSelected();
        }
      },
      Backspace: () => {
        const store = useViewerStore.getState();
        if (store.ignoreEditMode !== "off") {
          store.deleteSelected();
        }
      },
      Escape: (e) => {
        const onEscape = optsRef.current.onEscape;
        if (onEscape) {
          // Held, it leaves once: the auto-repeats are not more presses.
          if (e.repeat) return;
          onEscape();
          return;
        }
        const store = useViewerStore.getState();
        if (store.ignoreEditMode !== "off") {
          store.setIgnoreEditMode("off");
        }
        // Also clear the selected diff region (RegionListPanel selection).
        store.setSelected(null);
      },
      // F-b: region copy/paste. `$mod` is tinykeys' cross-platform alias
      // (Ctrl on Win/Linux, Cmd on Mac). Plain `C` is already bound to
      // toggle the comment panel, so we use the modified form here.
      "$mod+C": (e) => {
        // Yield to the browser's own copy when text is selected.
        if (hasTextSelection()) return;
        const projectId = optsRef.current.projectId;
        if (!projectId) return;
        const store = useViewerStore.getState();
        if (store.ignoreEditMode === "off" || !store.selectedIgnoreId) return;
        const region = selectEffectiveRegion(store);
        if (!region) return;
        setClipboardRegion(projectId, region);
        toast.success("Region copied");
        e.preventDefault();
      },
      "$mod+V": (e) => {
        const projectId = optsRef.current.projectId;
        if (!projectId) return;
        const store = useViewerStore.getState();
        if (store.ignoreEditMode === "off") return;
        const clipboard = getClipboardRegion(projectId);
        if (!clipboard) return;
        store.addDraftRegion({
          ...clipboard,
          id: crypto.randomUUID(),
          viewport: store.viewport || clipboard.viewport,
        });
        e.preventDefault();
      },
      // ⌘Z takes back the newest review action. Auto-repeat is ignored, like
      // approve and reject, so holding the keys cannot walk the stack back.
      // Shift is not matched, so ⇧⌘Z (redo) passes through untouched.
      "$mod+Z": (e) => {
        if (e.repeat) return;
        optsRef.current.onUndo?.();
        e.preventDefault();
      },
      // Zoom shortcuts. `=` is the unshifted key labeled "+" on US layouts —
      // binding both `+` and `=` covers Shift-+ and bare-= without forcing
      // users to chord. `0` resets to fit.
      "=": () => {
        useViewerStore.getState().zoomBy(ZOOM_STEP);
      },
      "+": () => {
        useViewerStore.getState().zoomBy(ZOOM_STEP);
      },
      "-": () => {
        useViewerStore.getState().zoomBy(1 / ZOOM_STEP);
      },
      "0": () => {
        useViewerStore.getState().resetZoom();
      },
    };
    // Guard every binding in one place so a newly added shortcut can't
    // forget to yield to inputs, menus, and dialogs.
    const guarded = Object.fromEntries(
      Object.entries(bindings).map(([key, handler]) => [
        key,
        (e: KeyboardEvent) => {
          if (keyIsOwnedElsewhere(e, key === "$mod+Z")) return;
          handler(e);
        },
      ]),
    );
    return tinykeys(window, guarded);
  }, [mode, setMode, viewport, setViewport]);
}
