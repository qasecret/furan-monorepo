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
        className="w-full inline-flex items-center justify-center rounded-md border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors"
        data-testid="logout-button"
      >
        Sign out
      </button>
    </form>
  );
}
