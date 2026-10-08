/**
 * Content-Security-Policy for every rendered dashboard page (set per request
 * by `src/middleware.ts`, which also hands the nonce to Next's renderer).
 *
 * - script-src: only scripts carrying this request's nonce run — Next tags its
 *   own bootstrap/chunk/flight scripts with it when it finds the nonce in the
 *   request's CSP header — plus whatever those scripts load ('strict-dynamic':
 *   webpack chunk loading). No 'unsafe-inline', no 'unsafe-eval' in production;
 *   pixi.js runs without eval via its `pixi.js/unsafe-eval` polyfill import.
 * - style-src keeps 'unsafe-inline': React renders `style=""` attributes
 *   (Radix positioning, chart sizing) that nonces can't cover. Style injection
 *   is a far weaker primitive than script injection; scripts stay locked down.
 * - img-src blob:/data: — screenshots are fetched with credentials and shown
 *   as object URLs (use-authed-image), never loaded cross-origin by <img>;
 *   connect-src blob: because the diff viewer's ImageLayer re-reads those
 *   object URLs with fetch() to decode them into ImageBitmaps.
 * - connect-src adds the api origin when NEXT_PUBLIC_API_URL is absolute
 *   (split-origin installs); a relative base (/api, single-origin) is 'self'.
 */
export interface CspOptions {
  nonce: string;
  /** The browser's api base — NEXT_PUBLIC_API_URL after normalizeApiBase. */
  apiBase: string;
  /** `next dev`: fast refresh needs eval and the HMR websocket. */
  dev: boolean;
}

export function buildContentSecurityPolicy({
  nonce,
  apiBase,
  dev,
}: CspOptions): string {
  const apiOrigin = apiBase.startsWith("/") ? null : new URL(apiBase).origin;
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      "blob:",
      ...(apiOrigin ? [apiOrigin] : []),
      ...(dev ? ["ws:"] : []),
    ],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}
