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
//
// The status toasts (`richColors`) keep sonner's tinted surface and border, but
// not its text colour: in the light theme that sits at 3.1:1 (warning) to 4.4:1
// against its own tint, under AA for 14px text. The text takes the status AA
// text shades instead (tokens.css; they are per-theme and pinned there), which
// read at 5.8:1 or better on those tints in light and stay AA in dark.
const TOASTER_STYLE = {
  "--normal-bg": "var(--overlay)",
  "--normal-text": "var(--fg)",
  "--normal-border": "var(--edge)",
  "--success-text": "var(--status-passed-text)",
  "--error-text": "var(--status-failed-text)",
  "--warning-text": "var(--status-unresolved-text)",
  "--info-text": "var(--status-running-text)",
  "--border-radius": "10px",
} as React.CSSProperties;

/**
 * Sonner toaster that follows the app theme. `resolvedTheme` is undefined
 * before mount, so it falls back to dark (avoiding a light flash) until the
 * theme resolves; the default theme is `system`, i.e. the OS scheme. Normal
 * toasts take the overlay tokens
 * so they match menus and dialogs in both themes; `richColors` success /
 * error / warning / info toasts deliberately keep sonner's status tints, with
 * their text on the status AA text tokens (see TOASTER_STYLE).
 * The toast elevation and its keyboard focus ring are unlayered rules in
 * app/globals.css: an inline box-shadow here would hide the focus ring.
 */
export function ThemedToaster(): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      richColors
      position="bottom-right"
      theme={resolvedTheme === "light" ? "light" : "dark"}
      style={TOASTER_STYLE}
    />
  );
}
