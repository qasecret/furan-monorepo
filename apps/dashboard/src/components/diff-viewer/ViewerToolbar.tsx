"use client";

import { useState } from "react";

import { useViewerStore, type ViewerMode } from "./useViewerStore";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";

const MODES: { value: ViewerMode; label: string }[] = [
  { value: "side-by-side", label: "Side-by-side" },
  { value: "overlay", label: "Overlay" },
  { value: "onion-skin", label: "Onion-skin" },
  { value: "diff-heatmap", label: "Diff heatmap" },
];

interface Props {
  /** The current run id — needed for the setIgnoreAreas mutation. */
  runId: string;
}

export function ViewerToolbar({ runId }: Props) {
  const mode = useViewerStore((s) => s.mode);
  const setMode = useViewerStore((s) => s.setMode);
  const opacity = useViewerStore((s) => s.opacity);
  const setOpacity = useViewerStore((s) => s.setOpacity);

  const ignoreEditMode = useViewerStore((s) => s.ignoreEditMode);
  const setIgnoreEditMode = useViewerStore((s) => s.setIgnoreEditMode);
  const savedRunIgnoreAreas = useViewerStore((s) => s.savedRunIgnoreAreas);
  const savedVariationIgnoreAreas = useViewerStore(
    (s) => s.savedVariationIgnoreAreas,
  );
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const markedForDeletion = useViewerStore((s) => s.markedForDeletion);
  const discardIgnoreChanges = useViewerStore((s) => s.discardIgnoreChanges);
  const applySaveSuccess = useViewerStore((s) => s.applySaveSuccess);

  const utils = trpc.useUtils();
  const setIgnoreAreas = trpc.runs.setIgnoreAreas.useMutation({
    onSuccess: (_data, vars) => {
      applySaveSuccess(vars.scope);
      void utils.runs.getById.invalidate({ runId });
    },
  });

  const [pendingScopeSwitch, setPendingScopeSwitch] = useState<
    "run" | "variation" | null
  >(null);

  const showSlider = mode === "overlay" || mode === "onion-skin";
  const sliderLabel =
    mode === "onion-skin" ? "Baseline ↔ Candidate" : "Candidate opacity";

  const editing = ignoreEditMode !== "off";
  const hasPendingChanges =
    draftIgnoreAreas.length > 0 || markedForDeletion.size > 0;

  const requestEditMode = (next: "run" | "variation") => {
    if (editing && ignoreEditMode !== next && hasPendingChanges) {
      setPendingScopeSwitch(next);
      return;
    }
    setIgnoreEditMode(next);
  };

  const confirmScopeSwitch = () => {
    if (!pendingScopeSwitch) return;
    discardIgnoreChanges();
    setIgnoreEditMode(pendingScopeSwitch);
    setPendingScopeSwitch(null);
  };

  const cancelScopeSwitch = () => setPendingScopeSwitch(null);

  const handleSave = () => {
    const scope = ignoreEditMode === "off" ? "run" : ignoreEditMode;
    const activeSaved =
      scope === "variation" ? savedVariationIgnoreAreas : savedRunIgnoreAreas;
    const survivors = activeSaved.filter((r) => !markedForDeletion.has(r.id));
    const payload = [...survivors, ...draftIgnoreAreas].map((r) => ({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      viewport: r.viewport,
    }));
    setIgnoreAreas.mutate({
      runId,
      scope,
      ignoreAreas: payload,
    });
  };

  return (
    <div className="flex items-center gap-4 p-2 border-b">
      <Tabs value={mode} onValueChange={(v) => setMode(v as ViewerMode)}>
        <TabsList>
          {MODES.map((m) => (
            <TabsTrigger key={m.value} value={m.value} data-mode={m.value}>
              {m.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={editing ? "default" : "secondary"}
            className="px-2 py-1 text-xs"
            data-testid="edit-regions-toggle"
            onClick={(e) => {
              if (editing) {
                e.preventDefault();
                setIgnoreEditMode("off");
              }
            }}
          >
            {editing
              ? `Editing: ${ignoreEditMode === "run" ? "this run" : "all runs"}`
              : "Edit regions ▾"}
          </Button>
        </DropdownMenuTrigger>
        {!editing && (
          <DropdownMenuContent>
            <DropdownMenuItem
              data-testid="edit-regions-run"
              onClick={() => requestEditMode("run")}
            >
              Edit for this run
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="edit-regions-variation"
              onClick={() => requestEditMode("variation")}
            >
              Edit for all runs of this test
            </DropdownMenuItem>
          </DropdownMenuContent>
        )}
        {editing && (
          <DropdownMenuContent>
            <DropdownMenuItem
              data-testid="switch-scope-run"
              onClick={() => requestEditMode("run")}
              disabled={ignoreEditMode === "run"}
            >
              Edit for this run
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="switch-scope-variation"
              onClick={() => requestEditMode("variation")}
              disabled={ignoreEditMode === "variation"}
            >
              Edit for all runs of this test
            </DropdownMenuItem>
          </DropdownMenuContent>
        )}
      </DropdownMenu>

      {editing && (
        <>
          <Button
            type="button"
            variant="default"
            className="px-2 py-1 text-xs"
            data-testid="ignore-save-button"
            disabled={!hasPendingChanges || setIgnoreAreas.isPending}
            onClick={handleSave}
          >
            {setIgnoreAreas.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid="ignore-discard-button"
            disabled={!hasPendingChanges || setIgnoreAreas.isPending}
            onClick={discardIgnoreChanges}
          >
            Discard
          </Button>
        </>
      )}

      {pendingScopeSwitch && (
        <div
          role="alertdialog"
          data-testid="scope-switch-confirm"
          className="flex items-center gap-2 text-xs"
        >
          <span>Discard unsaved changes and switch scope?</span>
          <Button
            type="button"
            variant="destructive"
            className="px-2 py-1 text-xs"
            data-testid="scope-switch-confirm-yes"
            onClick={confirmScopeSwitch}
          >
            Discard & switch
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid="scope-switch-confirm-no"
            onClick={cancelScopeSwitch}
          >
            Cancel
          </Button>
        </div>
      )}

      {showSlider && (
        <div
          className="flex items-center gap-2 min-w-[200px]"
          data-testid="opacity-slider-wrap"
        >
          <span className="text-xs text-muted-foreground">{sliderLabel}</span>
          <Slider
            value={[Math.round(opacity * 100)]}
            onValueChange={([v]) => setOpacity((v ?? 0) / 100)}
            min={0}
            max={100}
            step={1}
            className="w-32"
            aria-label={sliderLabel}
          />
        </div>
      )}
    </div>
  );
}
