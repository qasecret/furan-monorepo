"use client";

import { useSyncExternalStore } from "react";

import { browserEnv } from "@/lib/env";

/**
 * The API base as an SDK must be given it: absolute. The one-file install's
 * `-proxy` image builds the dashboard with the root-relative `/api`, which
 * the browser resolves against the page and no SDK can; an absolute base
 * (`compose.yml`'s `http://localhost:3000`) is returned as it is. No trailing
 * slash either way.
 */
export function absoluteApiUrl(base: string, origin: string): string {
  return new URL(base, origin).href.replace(/\/+$/, "");
}

const noSubscribe = () => () => {};

/**
 * `absoluteApiUrl` for this page, or `null` until mounted: the server has no
 * origin, so its render and the first client render agree on `null` and the
 * caller shows a placeholder instead of a guess.
 */
export function useApiUrl(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () =>
      absoluteApiUrl(browserEnv.NEXT_PUBLIC_API_URL, window.location.origin),
    () => null,
  );
}
