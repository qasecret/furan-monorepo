"use client";

import dynamic from "next/dynamic";
import { use } from "react";

/**
 * Dynamic-import the DiffViewer with ssr:false to keep pixi.js out of
 * the shared bundle. Bundle-isolation is asserted in the test harness
 * (mock pixi) and observable in the Next build output.
 */
const DiffViewer = dynamic(
  () => import("@/components/diff-viewer/DiffViewer").then((m) => m.DiffViewer),
  {
    ssr: false,
    loading: () => <div className="p-4">Loading diff viewer…</div>,
  },
);

export default function Page({
  params,
}: {
  params: Promise<{ projectId: string; runId: string; diffId: string }>;
}) {
  // Next 15: params is a Promise even in Client Components — unwrap with React `use()`.
  const { runId, diffId } = use(params);
  return <DiffViewer runId={runId} diffId={diffId} />;
}
