"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { JWT_COOKIE } from "@/lib/auth";

/**
 * Clears the dashboard JWT cookie and bounces to /login. The JWT is
 * stateless on the api side (no server-side revocation list in v1.0), so
 * sign-out is purely cookie deletion — anyone who still holds the raw
 * token can keep using it until it expires. PATs revoke individually via
 * the Tokens page; dashboard JWTs can't, by design.
 */
export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(JWT_COOKIE);
  redirect("/login");
}
