"use client";

import { useSyncExternalStore } from "react";

import type { Platform } from "./types";

type NavigatorWithUAData = Navigator & {
  userAgentData?: { platform?: string };
};

const MAC = /mac|iphone|ipad|ipod/i;

/**
 * macOS (and iOS, whose keyboards also use ⌘) or not. `navigator.platform`
 * comes first because tinykeys reads it to decide what `$mod` binds to, so
 * the glyphs shown always match the key that is bound.
 */
function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const nav = navigator as NavigatorWithUAData;
  const source =
    nav.platform || nav.userAgentData?.platform || nav.userAgent || "";
  return MAC.test(source) ? "mac" : "other";
}

// The platform never changes while the page is open.
const subscribe = () => () => undefined;
const serverSnapshot = (): Platform => "other";

/**
 * "mac" or "other", for showing ⌘ / Ctrl. The server, and the client's
 * hydrating render, always say "other", so their HTML matches; the client
 * re-renders with the real platform straight after hydration.
 */
export function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, detectPlatform, serverSnapshot);
}
