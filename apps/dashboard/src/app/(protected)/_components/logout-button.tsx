"use client";

import { logoutAction } from "./logout-action";

/**
 * Sidebar sign-out trigger. Submits a form that calls the server action so
 * we go through the Next.js server-action path (cookies().delete()) rather
 * than fighting the HttpOnly cookie from the browser.
 */
export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className="w-full inline-flex items-center justify-center rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 transition-colors dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-900"
        data-testid="logout-button"
      >
        Sign out
      </button>
    </form>
  );
}
