import { cache } from "react";

import { apiGet } from "./api-client";

export interface ProjectSummary {
  id: string;
  name: string;
  mainBranchName?: string;
}

/**
 * Project lookup shared by the project layout and its tab pages. Wrapped in
 * React's `cache()` so the layout's header fetch and a page's 403/404 gating
 * fetch dedupe into a single request-scoped call — `apiGet` sets
 * `cache: "no-store"`, which otherwise defeats fetch-level dedup.
 */
export const getProject = cache((projectId: string) =>
  apiGet<ProjectSummary>(`/projects/${projectId}`),
);
