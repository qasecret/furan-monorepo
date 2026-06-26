import { cache } from "react";

import { apiGet } from "./api-client";
import type { ViewerRole } from "./roles";

// Re-exported so existing `@/lib/get-viewer` importers keep working; the pure
// helpers + type now live in `./roles` (no React/network deps).
export type { ViewerRole } from "./roles";
export { isAtLeastAdmin, isOwner, canReviewRole } from "./roles";

/**
 * The current viewer's workspace role, request-`cache()`d so multiple server
 * components in one render share a single `/users/me` round-trip. Degrades to
 * "guest" on miss (a transient introspection failure must never widen access).
 */
export const getViewerRole = cache(async (): Promise<ViewerRole> => {
  const me = await apiGet<{ role: ViewerRole }>("/users/me").catch(() => ({
    status: 0,
    data: null as { role: ViewerRole } | null,
  }));
  return me.data?.role ?? "guest";
});
