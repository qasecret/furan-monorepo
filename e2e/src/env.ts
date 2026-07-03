/**
 * Canonical host URLs for the isolated e2e stack (compose.e2e-ports.yml maps
 * api → 3010 and dashboard → 3011 to coexist with a dev `pnpm dev` on
 * 3000/3001). The orchestrator (scripts/e2e.ts) exports E2E_API_URL /
 * E2E_DASH_URL to these values before spawning Playwright; the `??` fallback
 * keeps a standalone `playwright test` (no orchestrator) pointed at the SAME
 * stack. Single source of truth — do not re-hardcode these ports elsewhere.
 */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:3010";
export const DASH_URL = process.env.E2E_DASH_URL ?? "http://localhost:3011";
