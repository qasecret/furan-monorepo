// Static security headers for every dashboard response (pages AND assets),
// applied by next.config.mjs `headers()`. The per-request, nonce-based
// Content-Security-Policy is set by src/proxy.ts instead.

import { readFileSync } from "node:fs";

/** @type {{ key: string, value: string }[]} */
export const SECURITY_HEADERS = [
  // Legacy twin of CSP `frame-ancestors 'none'` (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Cross-origin requests (the api, external links) see the origin only —
  // never project/run ids from the path.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];

// HSTS is only honored over https, and pinning a host to https is sticky for a
// year — so it is sent only when the request reached the dashboard over https
// (a TLS-terminating proxy sets X-Forwarded-Proto). No includeSubDomains: other
// hosts on the operator's domain may legitimately still serve plain http.
export const HSTS_HEADER = {
  key: "Strict-Transport-Security",
  value: "max-age=31536000",
};

// ── The docs portal at /docs (spec 2026-11-01-docs-portal §5, ADR-080) ──────
// The dashboard image carries the built portal in public/docs. Its pages are
// static HTML with a few inline scripts, so they skip the nonce middleware and
// get this static policy instead: the same directives as src/lib/csp.ts, with
// script-src allowing exactly the hashes the docs build wrote.

/**
 * @param {string[]} scriptHashes `'sha256-…'` sources from csp-hashes.json
 * @returns {string}
 */
export function buildDocsCsp(scriptHashes) {
  /** @type {Record<string, string[]>} */
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...scriptHashes],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
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

/**
 * The docs build's inline-script hashes, or null when the docs aren't built
 * (`next dev`, unit tests): then there's no /docs to protect.
 * @param {string} file path to csp-hashes.json
 * @returns {string[] | null}
 */
export function readDocsScriptHashes(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(raw).scriptHashes;
}

// Docusaurus builds pages as x.html (trailingSlash: false). Fallback rewrites
// run after the filesystem, so real files (/docs/assets/…) are served as-is.
export const DOCS_REWRITES = [
  { source: "/docs", destination: "/docs/index.html" },
  { source: "/docs/:path+", destination: "/docs/:path+.html" },
];
