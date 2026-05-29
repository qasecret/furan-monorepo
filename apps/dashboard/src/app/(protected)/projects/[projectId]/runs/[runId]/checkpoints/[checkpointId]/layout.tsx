import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The checkpoint diff viewer page is a client component (it dynamic-imports
 * pixi.js via `next/dynamic ssr:false`), so it can't export `metadata`
 * directly. This layout segment sets the document title for the route.
 */
export const metadata: Metadata = { title: "Diff viewer" };

export default function CheckpointLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
