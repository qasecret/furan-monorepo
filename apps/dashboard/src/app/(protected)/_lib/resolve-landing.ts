/**
 * Single-project tenancy landing resolver (U8).
 *
 * A user's `default_project_id` is their assigned landing project. Given the
 * `/users/me` shape (role + defaultProjectId) and the user's visible
 * `/projects` (ALL for admins, memberships for editors), decide where they
 * land after login / on the bare app URL:
 *
 *   1. Default project, IF it's still in the visible set → its Builds.
 *      (Guard against a stale default the user was removed from.)
 *   2. Otherwise, exactly one visible project → that project's Builds.
 *      (Unambiguous; no switcher needed.)
 *   3. Otherwise admins → the Admin → Projects hub (assign yourself a default).
 *   4. Otherwise (editor, 0 or 2+ projects with no usable default) → null,
 *      and the caller renders the "no project assigned" empty state. There is
 *      deliberately no project switcher in single-project tenancy, so 2+
 *      projects without a default is not a pickable state.
 *
 * Pure + dependency-free so it unit-tests with plain matchers and can be
 * imported from both server resolvers and (potential) client callers.
 */
export function resolveLanding(
  me: { role: string; defaultProjectId: string | null },
  projects: { id: string }[],
): string | null {
  if (me.defaultProjectId && projects.some((p) => p.id === me.defaultProjectId))
    return `/projects/${me.defaultProjectId}/builds`;
  const sole = projects[0];
  if (projects.length === 1 && sole) return `/projects/${sole.id}/builds`;
  if (me.role === "admin") return "/admin/projects";
  return null;
}
