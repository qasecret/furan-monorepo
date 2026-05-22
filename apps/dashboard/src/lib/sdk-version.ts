/**
 * SDK version advertised in the dashboard's onboarding hints (empty-state
 * Gradle snippets on /projects/<id>/builds and /runs).
 *
 * Single source of truth is packages/sdk-kotlin/version.txt — Maven Central
 * is the one the user actually pulls from. Mirror it here when that file
 * changes (release-please bumps version.txt, then a follow-up dashboard
 * commit bumps this constant). README.md also mirrors it; keep all three
 * in lock-step.
 */
export const FURAN_SDK_VERSION = "0.8.0";
