"use client";

import dynamic from "next/dynamic";

import type { ViewerMode } from "@/components/diff-viewer/comparison-modes";
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
      "Compare the baseline and the current screenshot in five modes: Side by side, Swipe, Flicker, Overlay and Diff. Adjust diff sensitivity, and add ignore regions for flaky areas.",
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
  /** The URL's comparison mode (spec §6.3); null when it names none. */
  view: ViewerMode | null;
  /** The server's answer for the request's role (R14). */
  canReview: boolean;
  /** The user whose viewer preferences apply; null with no user. */
  userId: string | null;
}

/**
 * The checkpoint page's client part: the viewer (code-split, client-only)
 * and its tour. The page hands it what the server knows: the URL's step,
 * review context and comparison mode, whether this viewer may decide, and
 * who they are.
 */
export function CheckpointViewer({
  projectId,
  runId,
  checkpointId,
  reviewContext,
  view,
  canReview,
  userId,
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
          view={view}
          canReview={canReview}
          userId={userId}
        />
      </PageContainer>
    </>
  );
}
