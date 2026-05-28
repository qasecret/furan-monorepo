"use client";

import { useQuery } from "@tanstack/react-query";

import { useProjectEvents } from "./useProjectEvents";

import { browserEnv } from "@/lib/env";

interface Project {
  id: string;
}

/**
 * Fetch the caller's project list via the REST `GET /projects` endpoint.
 * No tRPC `projects.list` procedure exists; project listing lives in the
 * Fastify REST layer.
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
 * One subscriber child per project. Each child calls `useProjectEvents` at
 * its own stable top-level — React mounts/unmounts children as the project
 * list changes, never altering hook order within a child. This is the
 * safe alternative to a hooks-in-a-loop pattern (the previous version of
 * `useInboxRealtime` was inlining `useProjectEvents` in a `for` over a list
 * whose length changes from 0 to N when the query resolves — exactly the
 * scenario that breaks React's hook indexing).
 */
function ProjectEventSubscriber({ projectId }: { projectId: string }): null {
  useProjectEvents(projectId);
  return null;
}

/**
 * Renderable that fans out per-project SSE subscriptions for the inbox.
 *
 * Mount it once at the inbox-page root. The pool inside `useProjectEvents`
 * is ref-counted, so two open inbox tabs collapse onto one TCP connection
 * per project.
 *
 * Bounded by org size — a typical user is in <20 projects.
 */
export function InboxRealtime(): React.ReactElement {
  const projectIds = useProjectIds();
  return (
    <>
      {projectIds.map((id) => (
        <ProjectEventSubscriber key={id} projectId={id} />
      ))}
    </>
  );
}
