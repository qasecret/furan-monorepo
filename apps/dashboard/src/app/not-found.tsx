import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
};

/**
 * App-wide 404. Next.js falls back to a bare "404 / This page could not
 * be found." view when no not-found.tsx exists; that strips the brand
 * and leaves users without a return path. The chrome here matches the
 * login-screen aesthetic — same Card, same brand mark — so a missed
 * URL feels like part of the app rather than a server error page.
 *
 * Intentionally not wrapped in the protected layout: serving an authed
 * shell on an unauthed visitor's stray URL leaks the nav surface.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-sunken p-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg bg-raised p-6 text-center shadow-raised">
        <div className="mx-auto flex h-8 w-8 rotate-12 items-center justify-center rounded-sm bg-brand">
          <div className="h-2 w-2 rounded-full bg-brand-fg" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">
            404 · Page not found
          </h1>
          <p className="mt-1 text-sm text-fg-secondary">
            The URL doesn&apos;t match anything in this workspace. The project
            or run may have been deleted, or the link may have a typo.
          </p>
        </div>
        <Button asChild variant="secondary" className="w-full">
          <Link href="/projects">Back to projects</Link>
        </Button>
      </div>
    </main>
  );
}
