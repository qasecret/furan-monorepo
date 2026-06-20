"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface ProjectListItem {
  id: string;
  name: string;
}

interface CurrentProjectContextValue {
  currentProjectId: string | null;
  currentProject: ProjectListItem | null;
  projects: ProjectListItem[];
}

const CurrentProjectContext = createContext<CurrentProjectContextValue | null>(
  null,
);

function resolveInitial(
  projects: ProjectListItem[],
  defaultId: string | null,
): string | null {
  if (defaultId && projects.some((p) => p.id === defaultId)) return defaultId;
  // No usable default: only auto-pick when there's exactly one visible project
  // (mirrors resolveLanding — 2+ projects without a default is not pickable,
  // there's no switcher). Otherwise the shell shows the no-project context.
  if (projects.length === 1) return projects[0]?.id ?? null;
  return null;
}

/**
 * Read-only project context (ADR-052). The project is admin-assigned; there is
 * no switching. `currentProjectId` = the user's default (validated against the
 * visible projects) -> first -> none. `projects` is the viewer's VISIBLE set
 * from `GET /projects` (ALL projects for admins, memberships for editors), so
 * the header label resolves a name for any project an admin is viewing.
 */
export function CurrentProjectProvider({
  initialProjects,
  initialDefaultProjectId,
  children,
}: {
  initialProjects: ProjectListItem[];
  initialDefaultProjectId: string | null;
  children: ReactNode;
}) {
  const currentProjectId = resolveInitial(
    initialProjects,
    initialDefaultProjectId,
  );
  const currentProject =
    initialProjects.find((p) => p.id === currentProjectId) ?? null;

  return (
    <CurrentProjectContext.Provider
      value={{ currentProjectId, currentProject, projects: initialProjects }}
    >
      {children}
    </CurrentProjectContext.Provider>
  );
}

export function useCurrentProject(): CurrentProjectContextValue {
  const ctx = useContext(CurrentProjectContext);
  if (!ctx) {
    throw new Error(
      "useCurrentProject must be used within a CurrentProjectProvider",
    );
  }
  return ctx;
}
