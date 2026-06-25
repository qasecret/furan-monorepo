"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Theme provider for the public/marketing surfaces (landing + login).
 *
 * The app's primary ThemeProvider lives inside the (protected) `Providers`
 * tree, which never mounts on signed-out pages — so without this wrapper the
 * public routes render with no `dark` class and every `dark:` utility on
 * them is inert. Config mirrors `app/providers.tsx` exactly (class strategy,
 * dark default, shared `furan-theme` storage key) so a visitor's theme choice
 * persists into the authenticated app and back.
 */
export function PublicThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="furan-theme"
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
