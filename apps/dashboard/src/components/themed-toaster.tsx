"use client";

import { useTheme } from "next-themes";
import type * as React from "react";
import { Toaster } from "sonner";

// sonner injects its stylesheet UNLAYERED, and unlayered CSS beats Tailwind v4's
// `@layer utilities` regardless of specificity — so utility classes on a toast
// (`bg-overlay`, `shadow-overlay`, ...) never apply. Drive sonner through its own
// CSS variables instead; inline style on the toaster element beats its sheet.
// `--overlay` / `--fg` / `--edge` are raw per-theme vars (tokens.css), so the
// surface follows the theme. `--border-radius` is the literal `10px` because
// `--radius-overlay` lives in `@theme inline` and may not exist as a runtime var.
const TOASTER_STYLE = {
  "--normal-bg": "var(--overlay)",
  "--normal-text": "var(--fg)",
  "--normal-border": "var(--edge)",
  "--border-radius": "10px",
} as React.CSSProperties;

// Sonner hardcodes the toast shadow in its sheet; an inline style wins.
const TOAST_OPTIONS = {
  style: { boxShadow: "var(--elevation-overlay)" },
} as const;

/**
 * Sonner toaster that follows the app theme. `resolvedTheme` is undefined
 * before mount, so it falls back to dark (the default theme) to avoid a
 * light flash. Normal toasts take the overlay tokens so they match menus and
 * dialogs in both themes; `richColors` success / error / warning / info toasts
 * deliberately keep sonner's status colours.
 */
export function ThemedToaster(): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      richColors
      position="bottom-right"
      theme={resolvedTheme === "light" ? "light" : "dark"}
      style={TOASTER_STYLE}
      toastOptions={TOAST_OPTIONS}
    />
  );
}
