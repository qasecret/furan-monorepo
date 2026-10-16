"use client";

import dynamic from "next/dynamic";

import { PageTour } from "@/components/tour/page-tour";
import { PageContainer } from "@/components/ui/page-container";
import type { ReviewContext } from "@/lib/review-context";

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

/**
 * The viewer's tour. It names no keys: the keys a reader has depend on their
 * role and the single-key switch, and the hint bar, the buttons' hints and
 * the `?` sheet already show them from the command registry (spec §1.1).
 */
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
      "Pixel-level diffs are rendered as red regions. Pan with click+drag, zoom with the mouse wheel.",
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

interface Props {
  projectId: string;
  runId: string;
  checkpointId: string;
  reviewContext: ReviewContext;
  /** The server's answer for the request's role (R14). */
  canReview: boolean;
}

/**
 * The checkpoint page's client part: the viewer (code-split, client-only)
 * and its tour. The page hands it what the server knows: the URL's step and
 * review context, and whether this viewer may decide.
 */
export function CheckpointViewer({
  projectId,
  runId,
  checkpointId,
  reviewContext,
  canReview,
}: Props) {
  return (
    <>
      <PageTour pageId="diff-viewer" steps={DIFF_VIEWER_TOUR} />
      <PageContainer fullBleed>
        <DiffViewer
          projectId={projectId}
          runId={runId}
          initialCheckpointId={checkpointId}
          reviewContext={reviewContext}
          canReview={canReview}
        />
      </PageContainer>
    </>
  );
}
