"use client";

import { useRouter } from "next/navigation";
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
  prevDiffHref?: string | null;
  nextDiffHref?: string | null;
  onHelpToggle?: () => void;
  onNextDiff?: () => void;
  onPrevDiff?: () => void;
}

function isTypingInInput(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return false;
}

function hasTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0;
}

/**
 * Wires keyboard shortcuts for the DiffViewer.
 *
 * `optsRef` indirection: callbacks (approve/reject/help) and href targets
 * are read through a ref so the underlying tinykeys binding does not need
 * to be torn down on every parent re-render.
 *
 * `?` is bound both bare and as `Shift+?` because on US-layout the `?`
 * key requires shift; tinykeys matches `key`, which is already `?` once
 * shift is held, but binding both keeps it robust across layouts.
 */
export function useDiffViewerShortcuts(opts: ShortcutOptions) {
  const router = useRouter();
  const mode = useViewerStore((s) => s.mode);
  const setMode = useViewerStore((s) => s.setMode);
  const viewport = useViewerStore((s) => s.viewport);
  const setViewport = useViewerStore((s) => s.setViewport);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    return tinykeys(window, {
      ArrowLeft: () => {
        const href = optsRef.current.prevDiffHref;
        if (href) router.push(href);
      },
      ArrowRight: () => {
        const href = optsRef.current.nextDiffHref;
        if (href) router.push(href);
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
      n: () => {
        if (isTypingInInput()) return;
        optsRef.current.onNextDiff?.();
      },
      p: () => {
        if (isTypingInInput()) return;
        optsRef.current.onPrevDiff?.();
      },
      A: () => optsRef.current.onApprove?.(),
      R: () => optsRef.current.onReject?.(),
      // `X` is the legacy reject hotkey from the predecessor frontend.
      // Aliased to onReject so power reviewers carrying muscle memory from
      // the old viewer hit the same action without retraining.
      X: () => optsRef.current.onReject?.(),
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
      Escape: () => {
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
        // Yield to the browser when the user is typing or selecting text
        // (audit panel, pattern editor, etc.).
        if (isTypingInInput()) return;
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
        if (isTypingInInput()) return;
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
      // Zoom shortcuts. `=` is the unshifted key labeled "+" on US layouts —
      // binding both `+` and `=` covers Shift-+ and bare-= without forcing
      // users to chord. `0` resets to fit. Skip when typing so users can
      // type "0" into the PatternEditor / audit comment.
      "=": () => {
        if (isTypingInInput()) return;
        useViewerStore.getState().zoomBy(ZOOM_STEP);
      },
      "+": () => {
        if (isTypingInInput()) return;
        useViewerStore.getState().zoomBy(ZOOM_STEP);
      },
      "-": () => {
        if (isTypingInInput()) return;
        useViewerStore.getState().zoomBy(1 / ZOOM_STEP);
      },
      "0": () => {
        if (isTypingInInput()) return;
        useViewerStore.getState().resetZoom();
      },
    });
  }, [router, mode, setMode, viewport, setViewport]);
}
