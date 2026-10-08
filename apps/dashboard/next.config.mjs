import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HSTS_HEADER, SECURITY_HEADERS } from "./security-headers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the Kotlin SDK version from its source-of-truth file so the
// onboarding snippets on /projects/<id>/builds + /runs always pin the
// current Maven Central release. release-please bumps version.txt; the
// next dashboard build picks it up automatically — no manual mirror.
const sdkVersion = readFileSync(
  path.resolve(__dirname, "../../packages/sdk-kotlin/version.txt"),
  "utf8",
).trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 4 Task 11: enable standalone output so the Dockerfile can copy
  // a minimal runtime tree (server.js + the trimmed node_modules subset
  // Next traces) instead of the full app + workspace deps. Required for
  // distroless deployment.
  // See: https://nextjs.org/docs/app/api-reference/next-config-js/output
  output: "standalone",
  // The monorepo lives above apps/dashboard, so Next must trace symlinks
  // up to the workspace root to find pnpm-linked deps. Without this hint
  // Next emits a build-time warning and the standalone output is missing
  // workspace package files.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  env: {
    NEXT_PUBLIC_FURAN_SDK_VERSION: sdkVersion,
  },
  // Don't advertise the framework (X-Powered-By: Next.js).
  poweredByHeader: false,
  // Static security headers on every response; CSP is per-request in
  // src/middleware.ts. See security-headers.mjs.
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        source: "/:path*",
        has: [{ type: "header", key: "x-forwarded-proto", value: "https" }],
        headers: [HSTS_HEADER],
      },
    ];
  },
};
export default nextConfig;
