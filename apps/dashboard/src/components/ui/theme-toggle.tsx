"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Theme switcher button.
 *
 * Renders `null` on the server and during the first client render to avoid
 * a hydration mismatch (server can't know the user's localStorage value).
 * After mount, swaps between Sun (dark active) and Moon (light active) glyphs.
 *
 * The actual light-theme styles are rolled out per page in Phase 1+. Until
 * those land, flipping the toggle changes `<html class>` but the visual
 * output is identical because no `dark:` prefixes have been added yet.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const isDark = theme === "dark";
  return (
    <Button
      variant="ghost"
      className="h-8 w-8 p-0 text-zinc-400 hover:text-white"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      data-testid="theme-toggle"
    >
      {isDark ? (
        <Sun className="h-4 w-4" aria-hidden />
      ) : (
        <Moon className="h-4 w-4" aria-hidden />
      )}
    </Button>
  );
}
