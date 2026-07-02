import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading fallback for the authenticated app. Next.js shows this
 * (via Suspense) while a `(protected)` Server Component streams, so a slow data
 * fetch renders a skeleton instead of freezing the whole view on a blank page.
 * The AppShell chrome stays put; only the page body shows the placeholder.
 */
export default function ProtectedLoading() {
  return (
    <div className="space-y-4 p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72" />
      <div className="space-y-3 pt-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
