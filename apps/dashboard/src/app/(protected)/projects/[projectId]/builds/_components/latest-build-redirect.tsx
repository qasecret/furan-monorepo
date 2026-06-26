"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";

/**
 * The Builds index (`/builds`) owns no build of its own. Builds and Review are
 * one experience, so this lands the reviewer on the latest build's Review page
 * (the batch detail) — with the builds-history panel beside it, matching the
 * reference's "Test Results of batch". Only the no-builds-yet case stays here
 * (the panel already shows the SDK onboarding, so this stays terse).
 */
export function LatestBuildRedirect({ projectId }: { projectId: string }) {
  const router = useRouter();
  // Use the default page (no forced limit:1) — a limit:1 query trips the build
  // list's cursor pagination, and we only need the newest build (first item,
  // ordered created_at DESC) to land on.
  const { data, isLoading, error } = trpc.builds.list.useQuery({ projectId });
  const latest = data?.items[0];

  useEffect(() => {
    if (latest) {
      router.replace(`/projects/${projectId}/builds/${latest.id}`);
    }
  }, [latest, projectId, router]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-1" aria-busy="true">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-2 h-48 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <p className="p-4 text-sm text-red-600 dark:text-red-400">
        Couldn’t load builds: {error.message}
      </p>
    );
  }
  if (!latest) {
    return (
      <EmptyState
        title="No builds to review yet"
        description="Run a test through the SDK and it'll appear here."
      />
    );
  }
  // Latest build found — the effect above is navigating to its Review page.
  return null;
}
