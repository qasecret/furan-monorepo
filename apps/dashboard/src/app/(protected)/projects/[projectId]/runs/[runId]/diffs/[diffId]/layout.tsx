import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The diff viewer page is a client component (it dynamic-imports pixi.js
 * via `next/dynamic ssr:false`), so it can't export `metadata` directly.
 * This layout segment sets the document title for the route so the
 * browser tab reads "Diff viewer · Furan" instead of falling back to
 * the brand-only default.
 */
export const metadata: Metadata = { title: "Diff viewer" };

export default function DiffViewerLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
