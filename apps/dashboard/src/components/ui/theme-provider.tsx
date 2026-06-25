"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * The single next-themes provider for the whole app. Mounted once at the top of
 * the root layout's <body> so its anti-FOUC inline script runs before any page
 * content paints, and so signed-out (landing/login) and signed-in surfaces all
 * share one theme source + storage key — no per-segment duplication, no flash
 * crossing the auth boundary.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="furan-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
