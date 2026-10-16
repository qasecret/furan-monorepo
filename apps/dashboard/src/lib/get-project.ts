import { cache } from "react";

import { apiGet } from "./api-client";

export interface ProjectSummary {
  id: string;
  name: string;
  mainBranchName?: string;
}

/**
 * Project lookup shared by the project pages and layouts (e.g. the builds
 * layout and its pages). Wrapped in React's `cache()` so several lookups of
 * one project in a request (a layout's and a page's 403/404 gating) dedupe
 * into a single request-scoped call — `apiGet` sets `cache: "no-store"`,
 * which otherwise defeats fetch-level dedup.
 */
export const getProject = cache((projectId: string) =>
  apiGet<ProjectSummary>(`/projects/${projectId}`),
);
