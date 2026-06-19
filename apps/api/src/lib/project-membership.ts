import { eq, projectMembers, projects, type DB } from "@furan/db";

import type { AuthedUser } from "../plugins/auth.js";

/**
 * Project IDs the caller is allowed to see, by role:
 *   admin  → every project
 *   editor → projects they are a member of (project_members)
 *   guest  → none
 *
 * Single source of truth for caller-scoped project enumeration, shared by the
 * cross-project inbox router (`trpc/v1/inbox.ts`) and the multiplexed events
 * SSE route (`routes/inbox-events.ts`). Mirrors the admin-bypass / member-only
 * semantics of `requireProjectMember` (ADR-022).
 */
export async function listAccessibleProjectIds(
  db: DB,
  auth: AuthedUser,
): Promise<string[]> {
  if (auth.role === "guest") return [];
  if (auth.role === "admin") {
    const rows = await db.select({ id: projects.id }).from(projects);
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, auth.id));
  return rows.map((r) => r.id);
}
