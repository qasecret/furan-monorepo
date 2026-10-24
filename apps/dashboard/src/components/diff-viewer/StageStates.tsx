"use client";

import { useId, useRef } from "react";

import type { ViewerMode } from "./comparison-modes";
import { IMAGE_ROLES, type ImageRole, type ImageSetState } from "./image-set";
import { RENDERERS, type HatchedImage } from "./modes/types";
import {
  intersectRect,
  worldToCanvas,
  type Rect,
  type Size,
  type Transform,
  type World,
} from "./viewer-geometry";
import { modeOnStep } from "./viewer-prefs";

import { Button } from "@/components/ui/button";
import { useFocusHandoff } from "@/hooks/use-focus-handoff";
import { cn } from "@/lib/cn";
import { diffErrorCopy, type DiffErrorCode } from "@/lib/diff-error-copy";

/**
 * What the viewer's stage can't show, and says instead (spec §3.4): DOM over
 * the canvas, never drawn in it.
 */
export type StageState =
  | { kind: "loading" }
  | { kind: "failed"; roles: ImageRole[] }
  /** Failed, then retried, and on its way again: its card stays, busy (M2). */
  | { kind: "retrying"; roles: ImageRole[] }
  | { kind: "no-baseline" }
  | { kind: "diff-size-mismatch"; baseline: Size; current: Size }
  | { kind: "diff-legacy-missing" }
  | { kind: "diff-no-changes" }
  /** The step's diff failed for good: there is no result to show (§10). */
  | { kind: "diff-failed"; code: DiffErrorCode }
  /** An image the mode draws that the GPU can't hold: it is left out (I2). */
  | { kind: "too-large"; role: ImageRole; size: Size; max: number };

export interface StageStatesInput {
  /**
   * The mode on screen (`viewer-mode`'s effective mode). One the step can't
   * show is side by side (R2), here too: a caller passing a chosen mode still
   * gets the step's.
   */
  mode: ViewerMode;
  set: ImageSetState;
  hasBaseline: boolean;
  /** The step's diff image was never kept apart from its run's (`stepDiffKey`). */
  legacyMissing: boolean;
  /** R4: the step has a pixel-diff region, or a diff percent above 0. */
  stepHasDiff: boolean;
  /** The loaded images' sizes. */
  sizes: { baseline?: Size; current?: Size; diff?: Size };
  /** The GPU's largest texture side, in px (`readMaxTextureSize`). */
  maxTextureSize: number;
  /** The roles whose Retry was pressed for the images now asked for. */
  retrying?: readonly ImageRole[];
  /**
   * The step's diff failed for good (`diffFailedAt`), and why. Its images may
   * be fine; what is missing is the comparison, so the messages about a
   * missing diff say nothing.
   */
  diffFailed?: DiffErrorCode | null;
}

/**
 * Every state that applies to the stage, in the order they show. Pure. Several
 * can apply at once (a failed diff image and a size mismatch).
 *
 * - **loading:** an image the mode needs is still on its way (one it doesn't
 *   draw is not waited for).
 * - **failed:** the images the mode needs that failed; the others don't stop
 *   it, or show.
 * - **retrying:** the retried ones the mode needs, while they are on their
 *   way again.
 * - **diff-failed:** the step has no diff result, and says why. It stands in
 *   for the messages about a missing diff (no changes, a lost image, sizes
 *   that differ) and for "no baseline yet", whose Approve is not on offer.
 * - **no-baseline:** a new test. Only side by side can show it.
 * - **too-large:** each image the mode draws that is wider or taller than the
 *   GPU's textures (Diff waits for the baseline but never draws it).
 * - **Diff only:** sizes that differ give no pixel diff. With both
 *   screenshots in at the same size and no diff image asked for (the step's
 *   key is null), R4: a step with no diff has no changes, and a step with a
 *   diff on a legacy run lost its image to history. A step with a diff on a
 *   run of one step says nothing.
 */
export function stageStates(input: StageStatesInput): StageState[] {
  const { set, hasBaseline, sizes, maxTextureSize: max } = input;
  const mode = modeOnStep(input.mode, hasBaseline);
  const renderer = RENDERERS[mode];
  const needs = renderer.needs({ hasBaseline });
  const { images, failed } = set;
  const states: StageState[] = [];

  const onItsWay = (r: ImageRole) => images[r] === undefined && !failed[r];
  if (set.status === "loading" && needs.some(onItsWay)) {
    states.push({ kind: "loading" });
  }

  const failedRoles = needs.filter((r) => failed[r] === true);
  if (failedRoles.length > 0) {
    states.push({ kind: "failed", roles: failedRoles });
  }
  const retrying = needs.filter(
    (r) => input.retrying?.includes(r) === true && onItsWay(r),
  );
  if (retrying.length > 0) states.push({ kind: "retrying", roles: retrying });

  if (input.diffFailed) {
    states.push({ kind: "diff-failed", code: input.diffFailed });
  } else if (!hasBaseline) {
    states.push({ kind: "no-baseline" });
  }

  for (const role of renderer.draws) {
    const size = sizes[role];
    if (size && (size.w > max || size.h > max)) {
      states.push({ kind: "too-large", role, size, max });
    }
  }

  if (mode === "diff" && !input.diffFailed) {
    const { baseline, current } = sizes;
    // Ready with no diff image, loaded or failed: none was asked for.
    const noDiffImage =
      set.status === "ready" && images.diff === undefined && !failed.diff;
    if (
      baseline &&
      current &&
      (baseline.w !== current.w || baseline.h !== current.h)
    ) {
      states.push({ kind: "diff-size-mismatch", baseline, current });
    } else if (noDiffImage && !input.stepHasDiff) {
      // Only with both screenshots in can it say they are the same (M4).
      if (baseline && current) states.push({ kind: "diff-no-changes" });
    } else if (noDiffImage && input.legacyMissing) {
      states.push({ kind: "diff-legacy-missing" });
    }
  }
  return states;
}

/**
 * The states for one pane of side by side: the baseline's (its failure and
 * retry, its size, and that there is none) over pane A, every other over
 * pane B.
 */
export function statesForPane(
  states: StageState[],
  pane: "baseline" | "current",
): StageState[] {
  const here = (role: ImageRole) =>
    (role === "baseline") === (pane === "baseline");
  return states.flatMap((s): StageState[] => {
    switch (s.kind) {
      case "failed":
      case "retrying": {
        const roles = s.roles.filter(here);
        return roles.length > 0 ? [{ kind: s.kind, roles }] : [];
      }
      case "too-large":
        return here(s.role) ? [s] : [];
      case "no-baseline":
        return pane === "baseline" ? [s] : [];
      default:
        return pane === "baseline" ? [] : [s];
    }
  });
}

/** The limit assumed when there is no GL context to ask. */
export const FALLBACK_MAX_TEXTURE_SIZE = 8192;

/**
 * The largest texture side the GPU takes, from a pixi renderer's WebGL
 * context (`gl.getParameter(gl.MAX_TEXTURE_SIZE)`); 8192 when there is no GL
 * context (another renderer), or no answer.
 */
export function readMaxTextureSize(renderer: unknown): number {
  try {
    const gl = (renderer as { gl?: WebGLRenderingContext } | null | undefined)
      ?.gl;
    const size: unknown = gl?.getParameter(gl.MAX_TEXTURE_SIZE);
    return typeof size === "number" && size > 0
      ? size
      : FALLBACK_MAX_TEXTURE_SIZE;
  } catch {
    return FALLBACK_MAX_TEXTURE_SIZE;
  }
}

/** The copy, verbatim from spec §8. */
const FAILED: Record<ImageRole, string> = {
  baseline: "Couldn't load the baseline.",
  current: "Couldn't load the current screenshot.",
  diff: "Couldn't load the diff image.",
};
const RETRY = "Retry";
const DIFF_FAILED = "This step's diff failed.";
const RETRY_DIFF = "Retry diff";
const NO_BASELINE =
  "No baseline yet. Approve this step to make it the baseline.";
const NO_CHANGES =
  "No pixel changes between the baseline and the current screenshot.";
const LEGACY_MISSING = "No diff image was kept for this step.";
const size = (s: Size) => `${s.w}×${s.h}`;
const sizeMismatch = (baseline: Size, current: Size) =>
  `The screenshots are different sizes (${size(baseline)} and ${size(current)}), so there's no pixel diff. Compare them with Side by side, Swipe or Flicker.`;
const tooLarge = (s: Size, max: number) =>
  `This screenshot is too large to draw on this device (${size(s)}; the limit is ${max} px).`;

/** The hatching's tooltips, verbatim from spec §8. */
export const HATCH_TOOLTIP: Record<HatchedImage, string> = {
  baseline: "Not in the baseline",
  current: "Not in the current screenshot",
};

const CARD =
  "flex max-w-md items-center gap-3 rounded-lg border border-edge bg-overlay px-3 py-2 text-left text-xs text-fg-secondary shadow-overlay";

/** A sentence and nothing to press: the pointer goes through to the canvas. */
function Message({ children }: { children: string }) {
  return <p className={cn(CARD, "pointer-events-none")}>{children}</p>;
}

/**
 * A failed image and its Retry. Retried, it stays while the image is on its
 * way again, with Retry busy and inert, so the keyboard keeps its place (M2);
 * failed again, the same Retry takes a press again. When it goes with the
 * focus on its Retry (the image came in), the focus goes to `onFocusLost`.
 */
function Failed({
  role,
  busy,
  onRetry,
  onFocusLost,
}: {
  role: ImageRole;
  busy: boolean;
  onRetry(role: ImageRole): void;
  onFocusLost?: () => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  useFocusHandoff(button, onFocusLost);
  return (
    <div className={cn(CARD, "pointer-events-auto")}>
      <p id={id}>{FAILED[role]}</p>
      {/* Named "Retry" as the copy says; the message describes which. */}
      <Button
        ref={button}
        type="button"
        variant="secondary"
        className="h-7 shrink-0 px-2 text-xs aria-disabled:cursor-wait aria-disabled:opacity-50"
        aria-describedby={id}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        onClick={() => {
          if (!busy) onRetry(role);
        }}
      >
        {RETRY}
      </Button>
    </div>
  );
}

/**
 * A step whose diff failed for good, and why (spec 2026-10-23 §10). The
 * danger tone is the edge and the lead sentence; the card itself stays opaque
 * over the canvas. Retry diff is there only for a viewer who may retry
 * (`onRetry`); while the retry is out (`busy`) it stays, inert, so the
 * keyboard keeps its place. When it goes with the focus on its button (the
 * step is being diffed again), the focus goes to `onFocusLost`.
 */
function DiffFailed({
  code,
  busy,
  onRetry,
  onFocusLost,
}: {
  code: DiffErrorCode;
  busy: boolean;
  onRetry?: () => void;
  onFocusLost?: () => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  useFocusHandoff(button, onFocusLost);
  // Read as one sentence by the live region: the lead, then the reason. The
  // button is named "Retry diff", as the copy says; the message describes it.
  return (
    <div
      className={cn(
        CARD,
        "border-status-failed/25",
        onRetry ? "pointer-events-auto" : "pointer-events-none",
      )}
      data-testid="stage-diff-failed"
    >
      <p id={id} className="min-w-0">
        <span className="font-medium text-status-failed-text">
          {DIFF_FAILED}
        </span>{" "}
        {diffErrorCopy(code)}
      </p>
      {onRetry && (
        <Button
          ref={button}
          type="button"
          variant="secondary"
          className="h-7 shrink-0 px-2 text-xs aria-disabled:cursor-wait aria-disabled:opacity-50"
          aria-describedby={id}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => {
            if (!busy) onRetry();
          }}
        >
          {RETRY_DIFF}
        </Button>
      )}
    </div>
  );
}

/**
 * The states' messages, over the top of the stage (a tall screenshot's card
 * runs below the fold). Loading has none: the canvas skeleton, the empty
 * card, shows it.
 *
 * - The polite live region is always there, empty when there is nothing to
 *   say, so a message that appears in it is announced (M3).
 * - Only a card with Retry takes the pointer; the region and every other card
 *   let it through to the canvas, so the editor, pan and zoom work under
 *   them (M1).
 * - The images' cards come first, one per role in a fixed order, so a card
 *   going from failed to retrying and back is the same element, and keeps
 *   the focus.
 * - A failed diff's card takes the pointer only with a Retry diff in it. That
 *   button is there when `onRetryDiff` is (the viewer may retry), and busy
 *   while `retryingDiff`.
 */
export function StageStates({
  states,
  onRetry,
  onRetryDiff,
  retryingDiff = false,
  onFocusLost,
}: {
  states: StageState[];
  onRetry(role: ImageRole): void;
  /** Retry the step's failed diff; absent for a viewer who may not. */
  onRetryDiff?: () => void;
  /** The retry of the step's diff is out. */
  retryingDiff?: boolean;
  /** Where the focus goes when a focused Retry's card goes. */
  onFocusLost?: () => void;
}) {
  const rolesOf = (kind: "failed" | "retrying") =>
    states.flatMap((s) => (s.kind === kind ? s.roles : []));
  const failed = rolesOf("failed");
  const retrying = rolesOf("retrying");
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-2 p-3"
      role="status"
      data-testid="stage-states"
    >
      {IMAGE_ROLES.filter(
        (r) => failed.includes(r) || retrying.includes(r),
      ).map((role) => (
        <Failed
          key={`image:${role}`}
          role={role}
          busy={!failed.includes(role)}
          onRetry={onRetry}
          onFocusLost={onFocusLost}
        />
      ))}
      {states.map((s) => {
        switch (s.kind) {
          case "no-baseline":
            return <Message key={s.kind}>{NO_BASELINE}</Message>;
          case "diff-size-mismatch":
            return (
              <Message key={s.kind}>
                {sizeMismatch(s.baseline, s.current)}
              </Message>
            );
          case "diff-no-changes":
            return <Message key={s.kind}>{NO_CHANGES}</Message>;
          case "diff-failed":
            return (
              <DiffFailed
                key={s.kind}
                code={s.code}
                busy={retryingDiff}
                onRetry={onRetryDiff}
                onFocusLost={onFocusLost}
              />
            );
          case "diff-legacy-missing":
            return <Message key={s.kind}>{LEGACY_MISSING}</Message>;
          case "too-large":
            return (
              <Message key={`${s.kind}:${s.role}`}>
                {tooLarge(s.size, s.max)}
              </Message>
            );
          default:
            // Loading has no message; the images' cards are above.
            return null;
        }
      })}
    </div>
  );
}

/**
 * Invisible hit areas over the hatching of `images` in one pane, each with
 * its tooltip (spec §3.1), placed by the world's transform. Under the
 * editor's overlay; pointer events reach the stage's pan and zoom through
 * them. With `within`, an image's are cut to the area it shows in (Swipe's
 * sides, R15), as its hatching is.
 */
export function HatchTooltips({
  world,
  images,
  transform,
  within,
}: {
  world: World;
  images: readonly HatchedImage[];
  transform: Transform;
  within?: Partial<Record<HatchedImage, Rect>>;
}) {
  return images.flatMap((image) =>
    world.missing[image].flatMap((missing) => {
      const area = within?.[image];
      const r = area ? intersectRect(missing, area) : missing;
      if (!r) return [];
      const from = worldToCanvas(transform, { x: r.x, y: r.y });
      const to = worldToCanvas(transform, { x: r.x + r.w, y: r.y + r.h });
      return (
        <div
          // The strip's own key: a swipe resizes it, it stays the same node.
          key={`${image}:${missing.x},${missing.y}`}
          className="absolute"
          style={{
            left: from.x,
            top: from.y,
            width: to.x - from.x,
            height: to.y - from.y,
          }}
          title={HATCH_TOOLTIP[image]}
          data-testid="hatch-tooltip"
        />
      );
    }),
  );
}
