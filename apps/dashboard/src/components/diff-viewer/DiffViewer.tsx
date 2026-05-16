"use client";

import { ViewerCanvas } from "./ViewerCanvas";
import { ViewerToolbar } from "./ViewerToolbar";

import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
  diffId: string;
}

// Solid-grey placeholder SVG. T9 will wire the authenticated storage proxy.
const PLACEHOLDER =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MDAiIGhlaWdodD0iNDAwIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZWVlIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtc2l6ZT0iMjQiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IiM2NjYiPlNjcmVlbnNob3Q8L3RleHQ+PC9zdmc+";

export function DiffViewer({ runId, diffId }: Props) {
  const { data, isLoading, error } = trpc.runs.getById.useQuery({ runId });

  if (isLoading) return <div className="p-4">Loading…</div>;
  if (error)
    return <div className="p-4 text-destructive">Error: {error.message}</div>;
  if (!data) return <div className="p-4">No run data.</div>;

  return (
    <div className="flex flex-col h-full" data-diff-id={diffId}>
      <ViewerToolbar />
      <ViewerCanvas baselineUrl={PLACEHOLDER} candidateUrl={PLACEHOLDER} />
    </div>
  );
}
