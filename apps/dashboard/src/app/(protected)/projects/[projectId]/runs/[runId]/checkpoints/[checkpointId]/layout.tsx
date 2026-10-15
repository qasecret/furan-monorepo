import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Sets the document title for the checkpoint diff viewer route. (The page
 * was a client component, which cannot export `metadata`; it is a server
 * component now, with the client-only viewer in `CheckpointViewer`, and the
 * title stays here.)
 */
export const metadata: Metadata = { title: "Diff viewer" };

export default function CheckpointLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
