import { cache } from "react";

import { apiGet } from "./api-client";

export type ViewerRole = "admin" | "editor" | "guest";

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

/** Editor/admin can approve/reject; guests are read-only. */
export function canReviewRole(role: ViewerRole): boolean {
  return role === "admin" || role === "editor";
}
