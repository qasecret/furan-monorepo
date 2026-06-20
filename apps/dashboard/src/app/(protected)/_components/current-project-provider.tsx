"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";

export interface ProjectListItem {
  id: string;
  name: string;
}

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
 * `/projects` + the viewer's `defaultProjectId`. Switching persists the choice
 * as the user's default (ADR-049 model B) and, when on a project-scoped route,
 * follows to the same tab under the new project; otherwise it stays put and the
 * page re-scopes via `currentProjectId`.
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
  const setDefault = trpc.account.setDefaultProject.useMutation();

  const setCurrentProject = (id: string): void => {
    if (id === currentProjectId) return;
    const prev = currentProjectId;
    setCurrentProjectId(id);
    setDefault.mutate(
      { projectId: id },
      {
        onError: () => {
          setCurrentProjectId(prev);
          toast.error("Couldn't switch project");
        },
      },
    );
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
