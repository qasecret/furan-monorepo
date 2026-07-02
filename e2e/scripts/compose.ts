import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

/** Repo root — this file lives at <root>/e2e/scripts/compose.ts. */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const PROJECT = "furan-e2e";
const COMPOSE_FILES = [
  "-f",
  "infra/docker/compose.yml",
  "-f",
  "infra/docker/compose.local-all.yml",
  // Isolate the e2e stack on 3010/3011 so it coexists with a dev `pnpm dev`.
  "-f",
  "e2e/scripts/compose.e2e-ports.yml",
];

/** Host URLs the e2e stack is reachable at (see compose.e2e-ports.yml). */
export const API_URL = "http://localhost:3010";
export const DASH_URL = "http://localhost:3011";

/** Bootstrap admin seeded on first boot (via FURAN_BOOTSTRAP_ADMIN_* below).
 *  Shared with the seeder so the two never drift. */
export const BOOTSTRAP_EMAIL = "e2e-admin@furan.test";
export const BOOTSTRAP_PASSWORD = "e2e-admin-password-1234";
/** Password given to every seeded role principal (owner/admin/editor/guest). */
export const USER_PASSWORD = "e2e-user-password-1234";

export type StorageMode = "s3" | "hdd";

/**
 * Write a throwaway env file that overlays the storage mode + E2E-specific
 * settings onto `infra/docker/.env`. Returns the temp file path. RLS is left
 * on (the production-hardened default) via whatever `DATABASE_URL_APP` the base
 * .env carries; the bootstrap admin is set so the api seeds it on first boot.
 */
export function writeEnv(mode: StorageMode): string {
  const base = readFileSync(join(ROOT, "infra/docker/.env"), "utf8");
  const overlay =
    mode === "s3"
      ? "STORAGE_KIND=s3\nCOMPOSE_PROFILES=s3\n"
      : "STORAGE_KIND=hdd\nCOMPOSE_PROFILES=hdd\nHDD_ROOT=/var/lib/furan/storage\n";
  const extra = [
    `FURAN_BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_EMAIL}`,
    `FURAN_BOOTSTRAP_ADMIN_PASSWORD=${BOOTSTRAP_PASSWORD}`,
    "",
  ].join("\n");
  const path = join(tmpdir(), `furan-e2e-${mode}.env`);
  writeFileSync(path, `${base}\n${overlay}${extra}`);
  return path;
}

function compose(envFile: string, args: string[]): ReturnType<typeof execa> {
  return execa(
    "docker",
    ["compose", "-p", PROJECT, "--env-file", envFile, ...COMPOSE_FILES, ...args],
    { cwd: ROOT, stdio: "inherit" },
  );
}

export async function up(mode: StorageMode): Promise<void> {
  await compose(writeEnv(mode), ["up", "-d"]);
}

export async function down(mode: StorageMode): Promise<void> {
  await compose(writeEnv(mode), ["down", "-v"]);
}

export async function logs(mode: StorageMode, service?: string): Promise<void> {
  const tail = service ? [service] : [];
  await compose(writeEnv(mode), ["logs", "--no-color", "--tail=200", ...tail]);
}
