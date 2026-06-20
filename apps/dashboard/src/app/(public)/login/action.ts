"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { JWT_COOKIE } from "@/lib/auth";
import { browserEnv } from "@/lib/env";

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export interface LoginState {
  error?: string;
  /**
   * Echoes the user's typed email back to the form on error so the page
   * can render it as the input's `defaultValue`. Without this, the
   * server-action re-render mounts fresh empty inputs and the user has
   * to retype their email after any failed submit — a real UX failure
   * for the login flow flagged in the 2026-05-24 UX audit.
   *
   * Password is intentionally NOT echoed back: a server action's return
   * value flows over the wire and would expose the password to anyone
   * who could inspect the response (Sentry replays, browser devtools
   * shared screens, accidental logging). Users retype the password —
   * that is the standard tradeoff and matches GitHub / Google / etc.
   */
  email?: string;
}

export async function loginAction(
  _prev: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  const emailRaw = (formData.get("email") as string | null) ?? "";
  const parsed = loginInput.safeParse({
    email: emailRaw,
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "invalid_input", email: emailRaw };
  }

  const res = await fetch(`${browserEnv.NEXT_PUBLIC_API_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  });

  if (!res.ok) {
    return { error: "invalid_credentials", email: parsed.data.email };
  }

  const body = (await res.json()) as { token: string };
  const store = await cookies();
  store.set(JWT_COOKIE, body.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });

  // Land on the authenticated resolver, which forwards to the user's default
  // project's Builds (or the Admin → Projects hub / no-project state). U8.
  redirect("/home");
}
