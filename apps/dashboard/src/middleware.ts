import { NextResponse, type NextRequest } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/csp";
import { browserEnv } from "@/lib/env";

/**
 * Per-request nonce-based Content-Security-Policy (see lib/csp.ts). The policy
 * goes on the response AND on the request Next renders from: Next reads the
 * nonce out of the request's `content-security-policy` header and stamps it on
 * its own scripts, and the root layout reads `x-nonce` for the inline scripts
 * it renders itself. Because every page needs a fresh nonce, pages render
 * dynamically (the root layout reads headers()).
 *
 * The static headers (X-Frame-Options, nosniff, Referrer-Policy, HSTS, …) live
 * in next.config.mjs so they also cover the assets this matcher skips.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  );
  const csp = buildContentSecurityPolicy({
    nonce,
    apiBase: browserEnv.NEXT_PUBLIC_API_URL,
    dev: process.env.NODE_ENV === "development",
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only: skip build assets, the image optimizer, route
      // handlers (JSON), and root-level static files (icon.svg, robots.txt).
      source: "/((?!_next/static|_next/image|api/|[^/]+\\.[a-z0-9]+$).*)",
      // Router prefetches fetch RSC payloads, not documents — no CSP needed.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
