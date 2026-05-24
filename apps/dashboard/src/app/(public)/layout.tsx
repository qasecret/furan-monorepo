import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Server-segment metadata for the public route group ((login)).
 * Pages inside this group can't override the title from client
 * components — the layout takes care of it so the browser tab reads
 * "Sign in · Furan" instead of just "Furan".
 */
export const metadata: Metadata = {
  title: "Sign in",
};

export default function PublicLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
