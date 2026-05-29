"use client";

import dynamic from "next/dynamic";
import { use } from "react";

import { PageTour } from "@/components/tour/page-tour";

/**
 * Dynamic-import the DiffViewer with ssr:false to keep pixi.js out of
 * the shared bundle.
 */
const DiffViewer = dynamic(
  () => import("@/components/diff-viewer/DiffViewer").then((m) => m.DiffViewer),
  {
    ssr: false,
    loading: () => <div className="p-4">Loading diff viewer…</div>,
  },
);

const DIFF_VIEWER_TOUR = [
  {
    target: "#diff-viewer-toolbar",
    title: "Viewer controls",
    content:
      "Switch between overlay / side-by-side / candidate-only modes, adjust diff sensitivity, and add ignore regions for flaky areas.",
    placement: "bottom" as const,
  },
  {
    target: "#diff-viewer-canvas",
    title: "Diff canvas",
    content:
      "Pixel-level diffs are rendered as red regions. Pan with click+drag, zoom with the mouse wheel. Use `A` to approve, `R` to reject, `C` to comment.",
    placement: "top" as const,
  },
  {
    target: "#diff-viewer-approval",
    title: "Review actions",
    content:
      "Approve to promote this candidate as the new baseline (branch-scoped), or reject to keep the existing one.",
    placement: "top" as const,
  },
];

export default function CheckpointPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string; checkpointId: string }>;
}) {
  const { projectId, runId, checkpointId } = use(params);
  return (
    <>
      <PageTour pageId="diff-viewer" steps={DIFF_VIEWER_TOUR} />
      <DiffViewer
        projectId={projectId}
        runId={runId}
        initialCheckpointId={checkpointId}
      />
    </>
  );
}
