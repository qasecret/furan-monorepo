"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export interface ProjectListItem {
  id: string;
  name: string;
}

/** Per-tab key holding the transiently-switched project (ADR-050). */
export const CURRENT_PROJECT_SESSION_KEY = "furan:current-project";

interface CurrentProjectContextValue {
  currentProjectId: string | null;
  currentProject: ProjectListItem | null;
  projects: ProjectListItem[];
  setCurrentProject: (id: string) => void;
}

const CurrentProjectContext = createContext<CurrentProjectContextValue | null>(
  null,
);

function resolveInitial(
  projects: ProjectListItem[],
  defaultId: string | null,
): string | null {
  if (defaultId && projects.some((p) => p.id === defaultId)) return defaultId;
  return projects[0]?.id ?? null;
}

/**
 * Single source of truth for "which project am I in." Seeded by server-fetched
 * `/projects` + the viewer's saved `defaultProjectId`. Switching is TRANSIENT
 * (ADR-050): it updates the view and persists in `sessionStorage` (per-tab), but
 * does NOT change the saved default — that's set on `/account/preferences`.
 * Resolution: session-stored (if accessible) → saved default → first → none.
 * On a project-scoped route, switching follows to the same tab under the new
 * project; otherwise it stays put and the page re-scopes via `currentProjectId`.
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
  const [projects] = useState(initialProjects);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(() =>
    resolveInitial(initialProjects, initialDefaultProjectId),
  );
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(CURRENT_PROJECT_SESSION_KEY);
      if (stored && projects.some((p) => p.id === stored)) {
        setCurrentProjectId(stored);
      }
    } catch {
      // sessionStorage unavailable (sandboxed iframe / blocked storage) — ignore
    }
  }, [projects]);

  const setCurrentProject = (id: string): void => {
    if (id === currentProjectId) return;
    setCurrentProjectId(id);
    try {
      window.sessionStorage.setItem(CURRENT_PROJECT_SESSION_KEY, id);
    } catch {
      // ignore storage failures — the switch still applies in-memory
    }
    if (
      pathname &&
      pathname.startsWith("/projects/") &&
      pathname !== "/projects"
    ) {
      const tab = pathname.split("/")[3] ?? "builds";
      router.push(`/projects/${id}/${tab}`);
    }
  };

  const currentProject =
    projects.find((p) => p.id === currentProjectId) ?? null;

  return (
    <CurrentProjectContext.Provider
      value={{ currentProjectId, currentProject, projects, setCurrentProject }}
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
