"use client";

import { toast } from "sonner";

import {
  VIEWER_MODE_COMMAND,
  VIEWER_MODE_LABEL,
  VIEWER_MODES,
  type ViewerMode,
} from "./comparison-modes";
import {
  focusInRail,
  railCollapsed,
  railOverlaid,
  railPresent,
  setRailCollapsed,
} from "./rail-state";
import { getClipboardRegion, setClipboardRegion } from "./region-clipboard";
import { selectEffectiveRegion, useViewerStore } from "./useViewerStore";
import { useViewState } from "./view-state";
import { ZOOM_STEP } from "./viewer-geometry";
import { modeInEditor, readEffectiveMode } from "./viewer-mode";
import { modeAvailable, useViewerPrefs } from "./viewer-prefs";

import { useCommands } from "@/lib/commands/registry";
import type { Command, CommandCtx } from "@/lib/commands/types";
import { canReviewRole } from "@/lib/roles";

/**
 * What the viewer's keys act on. A callback is given exactly when its key
 * applies: the DiffViewer leaves one out while the done card is up (R20,
 * R28), while the review loop is off, or at the end of the steps, and the
 * command is then disabled (`enabled`), so the key is left to the browser.
 */
export interface ShortcutOptions {
  viewports: string[];
  /**
   * Project id — keys the per-project region clipboard for the
   * `$mod+C` / `$mod+V` shortcuts. Optional so existing callers that
   * predate region copy/paste still compile; when empty, copy and paste
   * are disabled (the browser's own copy and paste apply).
   */
  projectId?: string;
  onApprove?: () => void;
  onReject?: () => void;
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
  /**
   * The step has a baseline. Without one only side by side is on screen
   * (R2), whatever mode is chosen, so the other modes' keys (2–5, `d`) and a
   * mode's own keys (`f`) are disabled. Defaults to true.
   */
  hasBaseline?: boolean;
  /**
   * The viewer's `?view` (`useViewerMode().view`): with the editor's override
   * and the preference, it decides the mode on screen, which the mode keys
   * read. Absent: no URL, the preference alone.
   */
  urlView?: ViewerMode | null;
  /**
   * The viewer's `setMode`: a mode key stores the mode and writes it to the
   * URL. Absent: the preference alone.
   */
  setMode?: (mode: ViewerMode) => void;
  /**
   * The modes the step on screen can show (`useViewerMode().available`): a
   * mode's key is on only where it is (R2, Task 8 M7). Absent: read from
   * `hasBaseline`.
   */
  available?: Record<ViewerMode, boolean>;
}

interface ViewerCtx extends CommandCtx, ShortcutOptions {}

const store = () => useViewerStore.getState();
const view = () => useViewState.getState();
const prefs = () => useViewerPrefs.getState();
/**
 * The mode on screen at the key press: the editor's override, the URL's
 * view, the preference, and side by side where the step can't show it
 * (`viewer-mode`, R2, R3).
 */
const modeShown = ({ urlView = null, hasBaseline = true }: ViewerCtx) =>
  readEffectiveMode(urlView, hasBaseline);
/** The step on screen can show `mode` (R2): its key and its radio are on. */
const isAvailable = (
  { available, hasBaseline = true }: ViewerCtx,
  mode: ViewerMode,
) => available?.[mode] ?? modeAvailable(mode, hasBaseline);
/**
 * Chooses a mode the way the viewer does, or, with no viewer, stores it. A
 * mode the step can't show is never chosen, nor stored (Task 8 M7).
 */
const chooseMode = (ctx: ViewerCtx, mode: ViewerMode) => {
  if (!isAvailable(ctx, mode)) return;
  if (ctx.setMode) ctx.setMode(mode);
  else prefs().set("mode", mode);
};
/**
 * The mode `o` goes to: the next in the keys' order (spec §4.1), round from
 * the last, that would show as itself. It skips what the step can't show (no
 * baseline), and, in the ignore-region editor, Swipe and Flicker, which show
 * as side by side there (§4.4). Null: no other mode to go to.
 */
function nextMode(ctx: ViewerCtx): ViewerMode | null {
  const from = VIEWER_MODES.indexOf(modeShown(ctx));
  const editing = isEditing();
  for (let i = 1; i < VIEWER_MODES.length; i += 1) {
    const mode = VIEWER_MODES[(from + i) % VIEWER_MODES.length]!;
    if (!isAvailable(ctx, mode)) continue;
    if (editing && modeInEditor(mode) !== mode) continue;
    return mode;
  }
  return null;
}

/**
 * Spec §4.1: one command per mode, on 1–5, in the modes' order. Each is on
 * only where the step can show its mode (a key that does nothing is the
 * browser's), and anyone's: none is a decision.
 */
const MODE_COMMANDS: Command<ViewerCtx>[] = VIEWER_MODES.map((mode, i) => ({
  id: VIEWER_MODE_COMMAND[mode],
  label: VIEWER_MODE_LABEL[mode],
  group: "View",
  keys: [String(i + 1)],
  scope: "viewer",
  enabled: (ctx) => isAvailable(ctx, mode),
  run: (ctx) => chooseMode(ctx, mode),
}));

const given = (callback: (() => void) | undefined) => callback !== undefined;

function hasTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0;
}

function isEditing(): boolean {
  return store().ignoreEditMode !== "off";
}

/** The viewer's own Esc has something to do: the editor or a selection. */
function viewerEscapes(): boolean {
  return isEditing() || view().selectedRegionId !== null;
}

/** The viewport `step` places from the current one, wrapping round. */
function cycleViewport(viewports: string[], step: 1 | -1): void {
  if (viewports.length === 0) return;
  const i = viewports.indexOf(store().viewport);
  const next =
    viewports[(i + step + viewports.length) % viewports.length] ?? viewports[0];
  if (next) store().setViewport(next);
}

/**
 * The region `$mod+C` copies: the selected ignore region, while the editor
 * is on and no text is selected on the page (a text selection is the
 * browser's to copy). Null: nothing for the viewer to copy.
 */
function regionToCopy({ projectId }: ViewerCtx) {
  if (!projectId || !isEditing() || !store().selectedIgnoreId) return null;
  if (hasTextSelection()) return null;
  return selectEffectiveRegion(store());
}

/** What `$mod+V` pastes: the project's copied region, while editing. */
function regionToPaste({ projectId }: ViewerCtx) {
  if (!projectId || !isEditing()) return null;
  return getClipboardRegion(projectId);
}

/**
 * Spec §4.4: the diff viewer's commands, ids and labels verbatim, in the
 * order the `?` sheet lists them. Approve and reject are for roles that
 * review; everything else is anyone's. ⌘Z, `?` and `/` are global commands.
 */
export const VIEWER_COMMANDS: Command<ViewerCtx>[] = [
  {
    // ← / → do not repeat: each step is a route change and a remount, and
    // the repeats of a held arrow would push the same stale target.
    id: "viewer.prevStep",
    label: "Previous step",
    group: "Navigate",
    keys: ["ArrowLeft"],
    scope: "viewer",
    primary: true,
    enabled: ({ onPrevStep }) => given(onPrevStep),
    run: ({ onPrevStep }) => onPrevStep?.(),
  },
  {
    id: "viewer.nextStep",
    label: "Next step",
    group: "Navigate",
    keys: ["ArrowRight"],
    scope: "viewer",
    primary: true,
    enabled: ({ onNextStep }) => given(onNextStep),
    run: ({ onNextStep }) => onNextStep?.(),
  },
  {
    // The review loop: holding J must not walk the queue (no `repeat`).
    id: "viewer.nextPending",
    label: "Next pending step",
    group: "Navigate",
    keys: ["j"],
    scope: "viewer",
    primary: true,
    enabled: ({ onNextPending }) => given(onNextPending),
    run: ({ onNextPending }) => onNextPending?.(),
  },
  {
    id: "viewer.prevPending",
    label: "Previous pending step",
    group: "Navigate",
    keys: ["k"],
    scope: "viewer",
    primary: true,
    enabled: ({ onPrevPending }) => given(onPrevPending),
    run: ({ onPrevPending }) => onPrevPending?.(),
  },
  {
    // N / P repeat: held, they walk the changes (R13). The stepper reads the
    // live store and wraps, so each repeat moves on from where the last left.
    id: "viewer.nextRegion",
    label: "Next change",
    group: "Navigate",
    keys: ["n"],
    scope: "viewer",
    repeat: true,
    enabled: ({ onNextDiff }) => given(onNextDiff),
    run: ({ onNextDiff }) => onNextDiff?.(),
  },
  {
    id: "viewer.prevRegion",
    label: "Previous change",
    group: "Navigate",
    keys: ["p"],
    scope: "viewer",
    repeat: true,
    enabled: ({ onPrevDiff }) => given(onPrevDiff),
    run: ({ onPrevDiff }) => onPrevDiff?.(),
  },
  {
    // [ / ] do not repeat, deliberately (the old binding did): there are few
    // viewports, and each switch loads the step's images again, so a held key
    // would only queue loads.
    id: "viewer.prevViewport",
    label: "Previous viewport",
    group: "View",
    keys: ["["],
    scope: "viewer",
    enabled: ({ viewports }) => viewports.length > 0,
    run: ({ viewports }) => cycleViewport(viewports, -1),
  },
  {
    id: "viewer.nextViewport",
    label: "Next viewport",
    group: "View",
    keys: ["]"],
    scope: "viewer",
    enabled: ({ viewports }) => viewports.length > 0,
    run: ({ viewports }) => cycleViewport(viewports, 1),
  },
  {
    // Holding the key must not send a second decision (no `repeat`). The
    // same action as the Approve button: the step and run gates, unsaved
    // ignore regions, the older-capture question and the loop's move.
    id: "review.approve",
    label: "Approve step",
    group: "Review",
    keys: ["a"],
    scope: "viewer",
    primary: true,
    allowed: ({ role }) => canReviewRole(role),
    enabled: ({ onApprove }) => given(onApprove),
    run: ({ onApprove }) => onApprove?.(),
  },
  {
    // `x` is the predecessor frontend's reject key, kept for muscle memory.
    id: "review.reject",
    label: "Reject step",
    group: "Review",
    keys: ["r", "x"],
    scope: "viewer",
    primary: true,
    allowed: ({ role }) => canReviewRole(role),
    enabled: ({ onReject }) => given(onReject),
    run: ({ onReject }) => onReject?.(),
  },
  ...MODE_COMMANDS,
  {
    // To Diff, and back to the mode it was left from. Off where the step
    // can't show Diff (no baseline), so it never stores it there.
    id: "viewer.difference",
    label: "Toggle difference view",
    group: "View",
    keys: ["d"],
    scope: "viewer",
    enabled: (ctx) => isAvailable(ctx, "diff"),
    run: (ctx) =>
      chooseMode(
        ctx,
        modeShown(ctx) === "diff" ? prefs().previousMode : "diff",
      ),
  },
  {
    // The five modes in the keys' order, skipping what can't show; off when
    // nothing else can (no baseline).
    id: "viewer.cycleMode",
    label: "Cycle view mode",
    group: "View",
    keys: ["o"],
    scope: "viewer",
    enabled: (ctx) => nextMode(ctx) !== null,
    run: (ctx) => {
      const next = nextMode(ctx);
      if (next) chooseMode(ctx, next);
    },
  },
  {
    // Spec §4.3: playing, it pauses on the frame on screen; paused, each
    // press swaps the frame, and the flicker's live region names it. No
    // `repeat`: a held key swaps once, so it never flashes at key-repeat
    // rate.
    id: "viewer.flicker.toggle",
    label: "Pause or swap flicker",
    group: "View",
    keys: ["f"],
    scope: "viewer",
    enabled: (ctx) => modeShown(ctx) === "flicker",
    run: () => {
      const { flickerFrame, flickerPlaying, setFlicker, swapFlicker } = view();
      if (flickerPlaying) setFlicker(flickerFrame, false);
      else swapFlicker();
    },
  },
  {
    id: "viewer.highlight",
    label: "Toggle highlight",
    group: "View",
    keys: ["h"],
    scope: "viewer",
    run: () => prefs().set("highlight", !prefs().prefs.highlight),
  },
  {
    // A request for the comments, as Mark as Bug makes: the rail opens on
    // its Comments tab, expanding when it is collapsed (spec §5), and takes
    // the request (`InfoRail`).
    id: "viewer.comments",
    label: "Toggle comments",
    group: "View",
    keys: ["c"],
    scope: "viewer",
    run: () => store().setCommentPanelOpen(true),
  },
  {
    // Spec §5: named for what it does. Only while a rail is on screen (not
    // over the done card or an empty run). Below 1024 px the change is the
    // visit's, never stored (`setRailCollapsed`).
    id: "viewer.rail.toggle",
    label: "Hide details",
    labelFor: () => (railCollapsed() ? "Show details" : "Hide details"),
    group: "View",
    keys: ["t"],
    scope: "viewer",
    enabled: () => railPresent(),
    run: () => setRailCollapsed(!railCollapsed()),
  },
  {
    // `=` is the unshifted key labelled "+" on US layouts; `+` is bound for
    // layouts that send it, and the dispatcher adds `Shift++` for those that
    // need Shift to type it.
    id: "viewer.zoomIn",
    label: "Zoom in",
    group: "View",
    keys: ["=", "+"],
    scope: "viewer",
    repeat: true,
    run: () => view().zoomBy(ZOOM_STEP),
  },
  {
    id: "viewer.zoomOut",
    label: "Zoom out",
    group: "View",
    keys: ["-"],
    scope: "viewer",
    repeat: true,
    run: () => view().zoomBy(1 / ZOOM_STEP),
  },
  {
    id: "viewer.fit",
    label: "Fit",
    group: "View",
    keys: ["0"],
    scope: "viewer",
    repeat: true,
    run: () => view().resetZoom(),
  },
  {
    // F14/F15: the ignore-region editor (ADR-031).
    id: "editor.toggle",
    label: "Edit ignore regions",
    group: "Editor",
    keys: ["i"],
    scope: "viewer",
    run: () => store().setIgnoreEditMode(isEditing() ? "off" : "run"),
  },
  {
    id: "editor.delete",
    label: "Delete selected region",
    group: "Editor",
    keys: ["Delete", "Backspace"],
    scope: "viewer",
    enabled: () => isEditing() && store().selectedIgnoreId !== null,
    run: () => store().deleteSelected(),
  },
  {
    // F-b: region copy. Plain `c` toggles the comments, hence the modifier.
    // Outside the editor, or with text selected, ⌘C is the browser's copy.
    id: "editor.copy",
    label: "Copy region",
    group: "Editor",
    keys: ["$mod+c"],
    scope: "viewer",
    enabled: (ctx) => regionToCopy(ctx) !== null,
    run: (ctx) => {
      const region = regionToCopy(ctx);
      if (!ctx.projectId || !region) return;
      setClipboardRegion(ctx.projectId, region);
      toast.success("Region copied");
    },
  },
  {
    // Outside the editor, or with nothing copied, ⌘V is the browser's paste.
    id: "editor.paste",
    label: "Paste region",
    group: "Editor",
    keys: ["$mod+v"],
    scope: "viewer",
    enabled: (ctx) => regionToPaste(ctx) !== null,
    run: (ctx) => {
      const clipboard = regionToPaste(ctx);
      if (!clipboard) return;
      store().addDraftRegion({
        ...clipboard,
        id: crypto.randomUUID(),
        viewport: store().viewport || clipboard.viewport,
      });
    },
  },
  {
    // Fires inside the done card (its one dialog), wherever focus is in it:
    // back to the batch. Held, it leaves once (no `repeat`).
    //
    // Esc closes the innermost thing that has it, one per press:
    // 1. the done card, wherever focus is;
    // 2. the rail laid over the canvas (below 1024 px), while focus is in
    //    it: the reviewer is in it, as in a popover;
    // 3. the editor, and the selection;
    // 4. that rail again, with focus elsewhere, once nothing else is open.
    // In a wide window the rail is part of the page, and Esc never closes it.
    id: "viewer.escape",
    label: "Leave editor / clear selection / back to batch (on a done card)",
    group: "Navigate",
    keys: ["Escape"],
    scope: "viewer",
    allowInDialog: "[data-done-card]",
    enabled: ({ onEscape }) =>
      given(onEscape) || viewerEscapes() || railOverlaid(),
    run: ({ onEscape }) => {
      if (onEscape) {
        onEscape();
        return;
      }
      if (railOverlaid() && (focusInRail() || !viewerEscapes())) {
        setRailCollapsed(true);
        return;
      }
      if (isEditing()) store().setIgnoreEditMode("off");
      // Also clear the selected diff region (RegionListPanel selection).
      view().setSelected(null);
    },
  },
];

/**
 * The DiffViewer's keys (spec §4.4), registered in the `viewer` scope while
 * it is mounted. The layout's one dispatcher binds them, applies the shared
 * guard (text fields, menus and dialogs, IME, auto-repeat, the single-key
 * switch) and runs them with these options, read live at each key press, so
 * a re-render never rebinds anything.
 */
export function useDiffViewerShortcuts(opts: ShortcutOptions): void {
  useCommands<ViewerCtx>("viewer", VIEWER_COMMANDS, opts);
}
