"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * The single next-themes provider for the whole app. Mounted once at the top of
 * the root layout's <body> so its anti-FOUC inline script runs before any page
 * content paints, and so signed-out (landing/login) and signed-in surfaces all
 * share one theme source + storage key — no per-segment duplication, no flash
 * crossing the auth boundary.
 *
 * With no stored choice the app follows the OS colour scheme (`system`). A
 * returning user's explicit `furan-theme` value ("light" | "dark") is kept and
 * always wins over the OS.
 */
export function ThemeProvider({
  children,
  nonce,
}: {
  children: ReactNode;
  /** CSP nonce for next-themes' inline anti-FOUC script (see lib/csp.ts). */
  nonce?: string;
}) {
  return (
    <NextThemesProvider
      nonce={nonce}
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="furan-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
