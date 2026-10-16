import { cache } from "react";

import { apiGet } from "./api-client";
import type { ViewerRole } from "./roles";

// Re-exported so existing `@/lib/get-viewer` importers keep working; the pure
// helpers + type now live in `./roles` (no React/network deps).
export type { ViewerRole } from "./roles";
export { isAtLeastAdmin, isOwner, canReviewRole } from "./roles";

/**
 * The current viewer: their user id and workspace role, request-`cache()`d so
 * every server component in one render shares a single `/users/me`
 * round-trip. Degrades to a guest with no id on miss (a transient
 * introspection failure must never widen access).
 */
export const getViewer = cache(
  async (): Promise<{ id: string | null; role: ViewerRole }> => {
    const me = await apiGet<{ id: string; role: ViewerRole }>(
      "/users/me",
    ).catch(() => ({
      status: 0,
      data: null as { id: string; role: ViewerRole } | null,
    }));
    return { id: me.data?.id ?? null, role: me.data?.role ?? "guest" };
  },
);

/** The current viewer's workspace role: `getViewer`'s, from the same call. */
export async function getViewerRole(): Promise<ViewerRole> {
  return (await getViewer()).role;
}
