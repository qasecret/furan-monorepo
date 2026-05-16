import "server-only";

import { readJwt } from "./auth";
import { browserEnv } from "./env";

export async function apiGet<T>(
  path: string,
): Promise<{ status: number; data: T | null }> {
  const jwt = await readJwt();
  const res = await fetch(`${browserEnv.NEXT_PUBLIC_API_URL}${path}`, {
    headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
    cache: "no-store",
  });
  if (!res.ok) {
    return { status: res.status, data: null };
  }
  const data = (await res.json()) as T;
  return { status: res.status, data };
}
