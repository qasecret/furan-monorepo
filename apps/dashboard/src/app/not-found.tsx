import type { Metadata } from "next";
import Link from "next/link";

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
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-black">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex h-8 w-8 rotate-12 items-center justify-center rounded-sm bg-brand">
          <div className="h-2 w-2 rounded-full bg-black" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            404 · Page not found
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            The URL doesn&apos;t match anything in this workspace. The project
            or run may have been deleted, or the link may have a typo.
          </p>
        </div>
        <Link
          href="/projects"
          className="inline-flex w-full items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
        >
          Back to projects
        </Link>
      </div>
    </main>
  );
}
