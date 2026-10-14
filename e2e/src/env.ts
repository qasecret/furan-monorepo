/**
 * Canonical host URLs for the isolated e2e stack (compose.e2e.yml, on 3010/3011
 * to coexist with a dev `pnpm dev` on 3000/3001). API_URL is the api itself, for
 * the test clients. DASH_URL is the browser's single origin: nginx serving the
 * dashboard, and the api under `/api/`, which is what the dashboard's browser
 * bundle calls. The orchestrator (scripts/e2e.ts) exports E2E_API_URL /
 * E2E_DASH_URL to these values before spawning Playwright; the `??` fallback
 * keeps a standalone `playwright test` (no orchestrator) pointed at the SAME
 * stack. Single source of truth — do not re-hardcode these ports elsewhere.
 */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3010";
export const DASH_URL = process.env.E2E_DASH_URL ?? "http://localhost:3011";
