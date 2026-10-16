"use client";

import { useId } from "react";

import type { ImageRole, ImageSetState } from "./image-set";
import { RENDERERS, type HatchedImage } from "./modes/types";
import {
  worldToCanvas,
  type Size,
  type Transform,
  type World,
} from "./viewer-geometry";
import { modeAvailable, type ViewerMode } from "./viewer-prefs";

import { Button } from "@/components/ui/button";

/**
 * What the viewer's stage can't show, and says instead (spec §3.4): DOM over
 * the canvas, never drawn in it.
 */
export type StageState =
  | { kind: "loading" }
  | { kind: "failed"; roles: ImageRole[] }
  | { kind: "no-baseline" }
  | { kind: "diff-size-mismatch"; baseline: Size; current: Size }
  | { kind: "diff-legacy-missing" }
  | { kind: "diff-no-changes" }
  | { kind: "too-large"; size: Size; max: number };

export interface StageStatesInput {
  /** The chosen mode; one the step can't show is side by side (R2). */
  mode: ViewerMode;
  set: ImageSetState;
  hasBaseline: boolean;
  /** The step's diff image was never kept apart from its run's (`stepDiffKey`). */
  legacyMissing: boolean;
  /** R4: the step has at least one diff region, or a diff percent above 0. */
  stepHasDiff: boolean;
  /** The loaded images' sizes. */
  sizes: { baseline?: Size; current?: Size };
  /** The GPU's largest texture side, in px (`readMaxTextureSize`). */
  maxTextureSize: number;
}

/**
 * Every state that applies to the stage, in the order they show. Pure. Several
 * can apply at once (a failed diff image and a size mismatch).
 *
 * - **loading:** an image the mode needs is still on its way (one it doesn't
 *   draw is not waited for).
 * - **failed:** the images the mode needs that failed; the others don't stop
 *   it, or show.
 * - **no-baseline:** a new test. Only side by side can show it.
 * - **too-large:** a screenshot wider or taller than the GPU's textures; the
 *   current one first.
 * - **Diff only:** sizes that differ give no pixel diff. With the same sizes
 *   and no diff image asked for (the step's key is null), R4: a step with no
 *   diff has no changes, and a step with a diff on a legacy run lost its
 *   image to history. A step with a diff on a run of one step says nothing.
 */
export function stageStates(input: StageStatesInput): StageState[] {
  const { set, hasBaseline, sizes, maxTextureSize: max } = input;
  const mode = modeAvailable(input.mode, hasBaseline)
    ? input.mode
    : "side-by-side";
  const needs = RENDERERS[mode].needs({ hasBaseline });
  const { images, failed } = set;
  const states: StageState[] = [];

  const waiting = needs.some((r) => images[r] === undefined && !failed[r]);
  if (set.status === "loading" && waiting) states.push({ kind: "loading" });

  const failedRoles = needs.filter((r) => failed[r] === true);
  if (failedRoles.length > 0) {
    states.push({ kind: "failed", roles: failedRoles });
  }

  if (!hasBaseline) states.push({ kind: "no-baseline" });

  const tooLarge = [sizes.current, sizes.baseline].find(
    (s): s is Size => s !== undefined && (s.w > max || s.h > max),
  );
  if (tooLarge) states.push({ kind: "too-large", size: tooLarge, max });

  if (mode === "diff") {
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
      states.push({ kind: "diff-no-changes" });
    } else if (noDiffImage && input.legacyMissing) {
      states.push({ kind: "diff-legacy-missing" });
    }
  }
  return states;
}

/**
 * The states for one pane of side by side: the baseline's (its failure, and
 * that there is none) over pane A, every other over pane B.
 */
export function statesForPane(
  states: StageState[],
  pane: "baseline" | "current",
): StageState[] {
  return states.flatMap((s): StageState[] => {
    if (s.kind === "failed") {
      const roles = s.roles.filter(
        (r) => (r === "baseline") === (pane === "baseline"),
      );
      return roles.length > 0 ? [{ kind: "failed", roles }] : [];
    }
    return (s.kind === "no-baseline") === (pane === "baseline") ? [s] : [];
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
  "pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border border-edge bg-overlay px-3 py-2 text-left text-xs text-fg-secondary shadow-overlay";

function Message({ children }: { children: string }) {
  return <p className={CARD}>{children}</p>;
}

function Failed({
  role,
  onRetry,
}: {
  role: ImageRole;
  onRetry(role: ImageRole): void;
}) {
  const id = useId();
  return (
    <div className={CARD}>
      <p id={id}>{FAILED[role]}</p>
      {/* Named "Retry" as the copy says; the message describes which. */}
      <Button
        type="button"
        variant="secondary"
        className="h-7 shrink-0 px-2 text-xs"
        aria-describedby={id}
        onClick={() => onRetry(role)}
      >
        {RETRY}
      </Button>
    </div>
  );
}

/**
 * The states' messages, over the top of the stage (a tall screenshot's card
 * runs below the fold). Loading has none: the canvas skeleton, the empty
 * card, shows it. The box lets pointer events through to the canvas but on
 * its messages.
 */
export function StageStates({
  states,
  onRetry,
}: {
  states: StageState[];
  onRetry(role: ImageRole): void;
}) {
  const shown = states.filter((s) => s.kind !== "loading");
  if (shown.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-2 p-3"
      role="status"
      data-testid="stage-states"
    >
      {shown.map((s) => {
        switch (s.kind) {
          case "failed":
            return s.roles.map((role) => (
              <Failed key={`failed:${role}`} role={role} onRetry={onRetry} />
            ));
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
          case "diff-legacy-missing":
            return <Message key={s.kind}>{LEGACY_MISSING}</Message>;
          case "too-large":
            return <Message key={s.kind}>{tooLarge(s.size, s.max)}</Message>;
          default:
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
 * them.
 */
export function HatchTooltips({
  world,
  images,
  transform,
}: {
  world: World;
  images: readonly HatchedImage[];
  transform: Transform;
}) {
  return images.flatMap((image) =>
    world.missing[image].map((r) => {
      const from = worldToCanvas(transform, { x: r.x, y: r.y });
      const to = worldToCanvas(transform, { x: r.x + r.w, y: r.y + r.h });
      return (
        <div
          key={`${image}:${r.x},${r.y}`}
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
