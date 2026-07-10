import { z } from "zod";

/**
 * Normalize the API base for client calls. Accepts EITHER an absolute URL
 * (`http://localhost:3000`, `https://api.example.com` — compose.yml / deploy.sh)
 * OR a root-relative path (`/api` — furan-compose.yml single-origin behind one
 * nginx port). A relative base makes every `${base}${path}` fetch same-origin,
 * so one exposed port serves both the UI and the API and works from any browser.
 * Trailing slashes are stripped; empty/undefined defaults to localhost:3000.
 * Anything else (e.g. a bare `host:port`) is rejected.
 */
export function normalizeApiBase(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (v === "") return "http://localhost:3000";
  if (v.startsWith("/")) return v.replace(/\/+$/, "") || "/";
  const u = new URL(v); // throws on a totally malformed value
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `NEXT_PUBLIC_API_URL must be an http(s):// URL or a root-relative path ` +
        `(e.g. /api); got "${v}"`,
    );
  }
  return u.toString().replace(/\/+$/, "");
}

const browserEnvSchema = z.object({
  // Validation lives in normalizeApiBase (absolute URL OR relative /path), so
  // this only asserts a non-empty string reaches the schema.
  NEXT_PUBLIC_API_URL: z.string().min(1),
  /**
   * Workspace label rendered in the sidebar chip next to the Furan logo.
   * Visible-only string; doesn't gate any backend behavior. Defaults to
   * "Self-hosted" so single-install deployments read coherently; SaaS-shaped
   * deployments can override with the customer's org name.
   */
  NEXT_PUBLIC_WORKSPACE_NAME: z.string().min(1).default("Self-hosted"),
});

export const browserEnv = browserEnvSchema.parse({
  NEXT_PUBLIC_API_URL: normalizeApiBase(process.env.NEXT_PUBLIC_API_URL),
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
  if (internal) return internal;
  const baked = browserEnv.NEXT_PUBLIC_API_URL;
  // A relative base (/api, single-origin furan-compose) has no host — server
  // code cannot fetch it. It MUST have API_INTERNAL_URL; fail loudly if not.
  if (baked.startsWith("/")) {
    throw new Error(
      `serverApiUrl: NEXT_PUBLIC_API_URL is relative ("${baked}") and ` +
        `API_INTERNAL_URL is unset — server-side code cannot fetch a relative ` +
        `URL. Set API_INTERNAL_URL (e.g. http://api:3000).`,
    );
  }
  return baked;
}
