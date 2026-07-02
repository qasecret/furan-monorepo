import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Role } from "../clients/api-client.js";

import type { SeededPrincipal, SeedResult } from "./seed.js";

const SEED_FILE = fileURLToPath(new URL("../../.seed.json", import.meta.url));

/**
 * Read the seed written by the Playwright globalSetup. Seeding runs ONCE per
 * run (globalSetup) and mints a fixed number of PATs; tests reuse those rather
 * than minting their own, so the PAT-mint rate limit (#367) never trips even on
 * a kept-alive stack.
 */
export function loadSeed(): SeedResult {
  try {
    return JSON.parse(readFileSync(SEED_FILE, "utf8")) as SeedResult;
  } catch {
    throw new Error(
      ".seed.json missing — the Playwright globalSetup (scripts/global-setup.ts) must run first",
    );
  }
}

export function principal(seed: SeedResult, role: Role): SeededPrincipal {
  const p = seed.principals.find((x) => x.role === role);
  if (!p) throw new Error(`no seeded ${role} principal`);
  return p;
}

export function projectId(seed: SeedResult, name: string): string {
  const p = seed.projects.find((x) => x.name === name);
  if (!p) throw new Error(`no seeded project ${name}`);
  return p.id;
}
