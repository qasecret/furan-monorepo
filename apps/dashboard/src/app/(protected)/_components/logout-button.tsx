"use client";

import { logoutAction } from "./logout-action";

/**
 * Top-nav sign-out trigger. Submits a form that calls the server action so
 * we go through the Next.js server-action path (cookies().delete()) rather
 * than fighting the HttpOnly cookie from the browser.
 */
export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className="underline text-sm text-muted-foreground hover:text-foreground"
        data-testid="logout-button"
      >
        Sign out
      </button>
    </form>
  );
}
