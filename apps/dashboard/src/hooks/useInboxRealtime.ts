"use client";

import { useQuery } from "@tanstack/react-query";

import { useProjectEvents } from "./useProjectEvents";

import { browserEnv } from "@/lib/env";

interface Project {
  id: string;
}

/**
 * Fetch the caller's project list via the REST `GET /projects` endpoint.
 * This mirrors what the command palette and projects page do — there is no
 * `trpc.projects.list` procedure; the listing is handled by a Fastify REST
 * route that returns `Project[]` directly.
 */
function useProjectIds(): string[] {
  const { data } = useQuery<Project[]>({
    queryKey: ["projects", "list"],
    queryFn: async () => {
      const res = await fetch(`${browserEnv.NEXT_PUBLIC_API_URL}/projects`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (Array.isArray(body)) return body as Project[];
      return [];
    },
    staleTime: 60_000,
  });
  return data?.map((p) => p.id) ?? [];
}

/**
 * Subscribe to every member project's SSE stream so the inbox refetches
 * when any project event fires. Uses the existing ref-counted EventSource
 * pool in `useProjectEvents` — calling it multiple times with the same
 * projectId is safe; identical projectIds collapse onto one TCP connection.
 *
 * Bounded by org size — a typical user is in <20 projects.
 *
 * Implementation note: hooks-in-a-loop is normally a React rules violation,
 * but the project-id list comes from a stable react-query cache. The loop
 * length only changes when project membership changes; that change arrives
 * from the server and triggers a re-render, which React handles cleanly as
 * long as the list is stable across renders for the same membership set.
 * The eslint-disable below is intentional and is documented for reviewers.
 *
 * The REST `GET /projects` endpoint (not tRPC) is used because there is no
 * `trpc.projects.list` procedure — project listing is handled by the Fastify
 * REST layer and the tRPC `projectsRouter` only exposes `getById` and
 * `listBranches`.
 */
export function useInboxRealtime(): void {
  const projectIds = useProjectIds();
  for (const id of projectIds) useProjectEvents(id);
}
