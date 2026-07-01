"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { trpc } from "@/lib/trpc";

/**
 * Hard slider bounds. Reviewers very rarely care about thresholds above
 * 5% — beyond that, runs almost always pass and the slider stops being
 * useful. Below ~0.001% the diff engine is at the noise floor anyway.
 * Keeping these as constants here (vs. the backend's 0-1 zod bound) lets
 * us shrink the slider range without giving up the underlying field.
 */
const SLIDER_MIN_PCT = 0;
const SLIDER_MAX_PCT = 5;
const SLIDER_STEP_PCT = 0.01;

/**
 * Quick-pick presets. Picked from the most common industry
 * sensitivity presets we hear about. Renders as 4 small chips inside
 * the dropdown so reviewers don't have to scrub a slider to a tenth-of-a-
 * percent target.
 */
const PRESETS: Array<{ label: string; pct: number }> = [
  { label: "0.1%", pct: 0.1 },
  { label: "0.5%", pct: 0.5 },
  { label: "1%", pct: 1 },
  { label: "5%", pct: 5 },
];

interface Props {
  runId: string;
  /** Per-run override (`null` = inherit). 0-1 fraction. */
  runOverride: number | null | undefined;
  /** Project default. 0-1 fraction. May be undefined while the project query loads. */
  projectThreshold: number | null | undefined;
}

function pctOf(fraction: number | null | undefined): number {
  if (fraction == null || !Number.isFinite(fraction)) return 0;
  return Math.round(fraction * 10000) / 100;
}

function fractionOf(pct: number): number {
  return pct / 100;
}

/**
 * In-viewer per-run diff-sensitivity slider. Mutates
 * `runs.setDiffThresholdOverride` and re-enqueues a diff job; the diff
 * viewer's SSE consumer (`useRunEvents`) refetches on `diff.completed` so
 * the new result lands automatically without a manual reload.
 *
 * UX choice: the slider edits a local pending value; the mutation only
 * fires on Apply (or a preset click). This prevents a slider-drag from
 * stamping the diff queue with N re-runs in flight.
 */
export function SensitivityControl({
  runId,
  runOverride,
  projectThreshold,
}: Props) {
  const effective = runOverride ?? projectThreshold ?? 0.001;
  const effectivePct = pctOf(effective);
  const isCustom = runOverride != null;

  const utils = trpc.useUtils();
  const mutation = trpc.runs.setDiffThresholdOverride.useMutation({
    onSuccess: (_data, vars) => {
      void utils.runs.getById.invalidate({ runId });
      toast.success(
        vars.threshold === null
          ? "Reset to project default — re-running diff"
          : `Sensitivity set to ${pctOf(vars.threshold)}% — re-running diff`,
      );
    },
    onError: (err) => toast.error(`Failed: ${err.message}`),
  });

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<number>(effectivePct);

  // Re-seed the slider on every popover open + whenever the effective
  // threshold changes (e.g. a sibling tab edited the project default).
  useEffect(() => {
    if (open) setPending(effectivePct);
  }, [open, effectivePct]);

  const apply = (pct: number) => {
    mutation.mutate({ runId, threshold: fractionOf(pct) });
    setOpen(false);
  };
  const reset = () => {
    mutation.mutate({ runId, threshold: null });
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs"
          data-testid="sensitivity-trigger"
          title="Per-run diff sensitivity"
        >
          Sensitivity: {effectivePct}%{isCustom ? " ✱" : ""}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72 p-3 space-y-3"
        data-testid="sensitivity-popover"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-600 dark:text-zinc-400">
            Diff threshold
          </span>
          <span className="font-mono" data-testid="sensitivity-pending-value">
            {pending.toFixed(2)}%
          </span>
        </div>
        <Slider
          value={[pending]}
          onValueChange={([v]) => setPending(v ?? 0)}
          min={SLIDER_MIN_PCT}
          max={SLIDER_MAX_PCT}
          step={SLIDER_STEP_PCT}
          aria-label="Per-run diff sensitivity (percent)"
          data-testid="sensitivity-slider"
        />
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              type="button"
              variant={pending === p.pct ? "default" : "secondary"}
              className="h-6 px-2 text-xs"
              onClick={() => setPending(p.pct)}
              data-testid={`sensitivity-preset-${p.label}`}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1 border-t">
          <Button
            type="button"
            variant="default"
            className="h-7 px-2 text-xs"
            disabled={
              mutation.isPending || fractionOf(pending) === (runOverride ?? -1)
            }
            onClick={() => apply(pending)}
            data-testid="sensitivity-apply"
          >
            {mutation.isPending ? "Re-running…" : "Apply"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="h-7 px-2 text-xs"
            disabled={mutation.isPending || !isCustom}
            onClick={reset}
            data-testid="sensitivity-reset"
            title={
              projectThreshold != null
                ? `Reset to project default (${pctOf(projectThreshold)}%)`
                : "Reset to project default"
            }
          >
            Reset to default
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
