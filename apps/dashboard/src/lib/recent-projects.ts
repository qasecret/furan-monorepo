export interface RecentProject {
  id: string;
  name: string;
}

const STORAGE_KEY = "furan:recent-projects";
const MAX_RECENT = 5;

/**
 * Most-recently-visited projects, newest first, persisted in localStorage so
 * the command palette can offer a "Recent" group. Capped at {@link MAX_RECENT}.
 * SSR-safe (returns `[]` when `window` is absent) and tolerant of malformed
 * stored data.
 */
export function getRecentProjects(): RecentProject[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is RecentProject =>
          !!p &&
          typeof p === "object" &&
          typeof (p as RecentProject).id === "string" &&
          typeof (p as RecentProject).name === "string",
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/**
 * Records a project visit: moves it to the front (de-duplicating by id) and
 * trims the list to the cap. No-op on the server or on storage errors.
 */
export function recordRecentProject(project: RecentProject): void {
  if (typeof window === "undefined") return;
  try {
    const next = [
      project,
      ...getRecentProjects().filter((p) => p.id !== project.id),
    ].slice(0, MAX_RECENT);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / serialization failures — recents are best-effort
  }
}
