"use client";

import { useTheme } from "next-themes";
import type * as React from "react";
import { Toaster } from "sonner";

/**
 * Sonner toaster that follows the app theme. `resolvedTheme` is undefined
 * before mount, so it falls back to dark (the default theme) to avoid a
 * light flash. Toast surfaces use the overlay tokens so they match menus and
 * dialogs in both themes.
 */
export function ThemedToaster(): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      richColors
      position="bottom-right"
      theme={resolvedTheme === "light" ? "light" : "dark"}
      toastOptions={{
        className: "rounded-overlay bg-overlay text-fg shadow-overlay",
      }}
    />
  );
}
