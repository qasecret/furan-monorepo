import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PublicThemeProvider } from "@/components/landing/public-theme-provider";

/**
 * Server-segment metadata for the public route group ((login)).
 * Pages inside this group can't override the title from client
 * components — the layout takes care of it so the browser tab reads
 * "Sign in · Furan" instead of just "Furan".
 */
export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * The public segment has no access to the (protected) `Providers` tree, so it
 * wraps its pages in their own next-themes provider (same config / storage key)
 * — without it, the login page's `dark:` utilities never engage.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicThemeProvider>{children}</PublicThemeProvider>;
}
