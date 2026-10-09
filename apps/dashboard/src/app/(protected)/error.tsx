"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for the authenticated app. Next.js renders this instead of a
 * blank white screen when a Server Component throws or a data fetch rejects in
 * any `(protected)` route. Scoped to this segment so the AppShell chrome stays
 * mounted and only the page content is replaced. `reset()` re-renders the
 * segment (retries the failed render) without a full reload.
 */
export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console (and any error-reporting hook) so the
    // failure isn't silent even though we render a friendly fallback.
    console.error("protected_route_error", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-fg">Something went wrong</h2>
        <p className="max-w-md text-sm text-fg-muted">
          This view failed to load. You can retry, or reload the page if the
          problem persists.
        </p>
        {error.digest ? (
          <p className="pt-1 font-mono text-xs tabular-nums text-fg-muted">
            ref: {error.digest}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button variant="default" onClick={() => reset()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
