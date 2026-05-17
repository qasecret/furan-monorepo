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
};
export default nextConfig;
