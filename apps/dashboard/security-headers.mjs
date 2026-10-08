// Static security headers for every dashboard response (pages AND assets),
// applied by next.config.mjs `headers()`. The per-request, nonce-based
// Content-Security-Policy is set by src/middleware.ts instead.

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
