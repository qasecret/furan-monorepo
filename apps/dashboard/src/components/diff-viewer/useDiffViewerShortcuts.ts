"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { tinykeys } from "tinykeys";

import { useViewerStore, type ViewerMode } from "./useViewerStore";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";

const MODES: ViewerMode[] = [
  "side-by-side",
  "overlay",
  "onion-skin",
  "diff-heatmap",
];

interface ShortcutOptions {
  viewports: string[];
  onApprove?: () => void; // T11 supplies these
  onReject?: () => void;
  prevDiffHref?: string | null;
  nextDiffHref?: string | null;
  onHelpToggle?: () => void;
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
        // Toggle diff overlay: cycle between current mode and diff-heatmap.
        setMode(mode === "diff-heatmap" ? "side-by-side" : "diff-heatmap");
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
      A: () => optsRef.current.onApprove?.(),
      R: () => optsRef.current.onReject?.(),
      "?": () => optsRef.current.onHelpToggle?.(),
      "Shift+?": () => optsRef.current.onHelpToggle?.(),
      // T9: `/` opens the global cmdk command palette. We reach into the
      // zustand store directly so the binding stays decoupled from props.
      "/": () => usePaletteStore.getState().setOpen(true),
    });
  }, [router, mode, setMode, viewport, setViewport]);
}
