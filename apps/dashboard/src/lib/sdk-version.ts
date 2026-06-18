/**
 * SDK version advertised in the dashboard's onboarding hints (empty-state
 * Gradle snippets on /projects/<id>/builds).
 *
 * Single source of truth is packages/sdk-kotlin/version.txt — the file
 * release-please writes to. next.config.mjs reads it at build time and
 * inlines it as NEXT_PUBLIC_FURAN_SDK_VERSION so the constant below
 * always tracks the latest Maven Central release. The fallback only
 * kicks in for unit-test runs that import this module without going
 * through a Next build.
 */
export const FURAN_SDK_VERSION =
  process.env.NEXT_PUBLIC_FURAN_SDK_VERSION ?? "0.9.0";
