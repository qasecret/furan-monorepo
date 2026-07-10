import { z } from "zod";

const browserEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
  /**
   * Workspace label rendered in the sidebar chip next to the Furan logo.
   * Visible-only string; doesn't gate any backend behavior. Defaults to
   * "Self-hosted" so single-install deployments read coherently; SaaS-shaped
   * deployments can override with the customer's org name.
   */
  NEXT_PUBLIC_WORKSPACE_NAME: z.string().min(1).default("Self-hosted"),
});

export const browserEnv = browserEnvSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_WORKSPACE_NAME: process.env.NEXT_PUBLIC_WORKSPACE_NAME,
});

/**
 * API base URL for SERVER-side callers — Server Actions (e.g. login), the
 * `server-only` `apiGet`, and SSR pages — which run INSIDE the dashboard
 * container.
 *
 * `NEXT_PUBLIC_API_URL` is inlined into both the client AND server bundles at
 * BUILD time, so it is frozen to whatever was baked (default
 * `http://localhost:3000`). That is correct for the host browser but wrong for
 * in-container server code, where `localhost:3000` is the dashboard itself, not
 * the `api` service (→ ECONNREFUSED). `API_INTERNAL_URL` is a plain
 * (non-`NEXT_PUBLIC_`) env var that Next reads at RUNTIME, so a single published
 * image can route SSR at `http://api:3000` while the browser bundle keeps its
 * baked URL. Falls back to the baked `NEXT_PUBLIC_API_URL` when unset (dev and
 * single-host source runs, where both callers share the host's localhost).
 */
export function serverApiUrl(): string {
  const internal = process.env.API_INTERNAL_URL?.trim();
  return internal ? internal : browserEnv.NEXT_PUBLIC_API_URL;
}
