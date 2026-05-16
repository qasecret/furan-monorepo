import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const JWT_COOKIE = "furan_jwt";

export async function readJwt(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(JWT_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

export async function requireJwt(): Promise<string> {
  const jwt = await readJwt();
  if (!jwt) redirect("/login");
  return jwt;
}
