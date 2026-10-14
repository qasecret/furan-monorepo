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
  // The five app services on images built from HEAD (`:local`)…
  "-f",
  "infra/docker/compose.local-all.yml",
  // …then the e2e overlay: host ports 3010/3011 (coexists with a dev `pnpm
  // dev`), the single-origin dashboard image, and nginx in front of both.
  "-f",
  "e2e/scripts/compose.e2e.yml",
];

/**
 * The app images the stack runs, built from HEAD. The dashboard is the `-proxy`
 * variant, as released for furan-compose.yml: its browser bundle calls the
 * relative `/api`, which nginx serves on the dashboard's own origin.
 */
export const IMAGES: ReadonlyArray<{
  app: string;
  tag: string;
  buildArgs?: string[];
}> = [
  { app: "api", tag: "qasecret/furan-api:local" },
  { app: "capture-worker", tag: "qasecret/furan-capture-worker:local" },
  { app: "diff-worker", tag: "qasecret/furan-diff-worker:local" },
  { app: "integrations", tag: "qasecret/furan-integrations:local" },
  {
    app: "dashboard",
    tag: "qasecret/furan-dashboard:local-proxy",
    buildArgs: ["NEXT_PUBLIC_API_URL=/api"],
  },
];

/**
 * Build any of IMAGES not present locally, from the current checkout. Present
 * images are reused as they are: rebuild (or `docker image rm`) to pick up new
 * code.
 */
export async function buildMissingImages(): Promise<void> {
  for (const { app, tag, buildArgs = [] } of IMAGES) {
    const inspect = await execa("docker", ["image", "inspect", tag], {
      reject: false,
      stdio: "ignore",
    });
    if (inspect.exitCode === 0) continue;
    console.log(`[e2e] building ${tag} from HEAD`);
    await execa(
      "docker",
      [
        "build",
        "-f",
        `apps/${app}/Dockerfile`,
        ...buildArgs.flatMap((a) => ["--build-arg", a]),
        "-t",
        tag,
        ".",
      ],
      { cwd: ROOT, stdio: "inherit", env: { DOCKER_BUILDKIT: "1" } },
    );
  }
}

/** Host URLs the e2e stack is reachable at — single source of truth in env.ts. */
export { API_URL, DASH_URL } from "../src/env.js";

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
  // Strip any STORAGE_KIND / COMPOSE_PROFILES / FURAN_DASHBOARD_ORIGIN the base
  // .env sets so the overlay is the single authoritative value (rather than a
  // duplicate key that only works by docker-compose's last-wins parsing).
  const base = readFileSync(join(ROOT, "infra/docker/.env"), "utf8")
    .split("\n")
    .filter(
      (l) =>
        !/^\s*(STORAGE_KIND|COMPOSE_PROFILES|FURAN_DASHBOARD_ORIGIN)=/.test(l),
    )
    .join("\n");
  const overlay =
    mode === "s3"
      ? "STORAGE_KIND=s3\nCOMPOSE_PROFILES=s3\n"
      : "STORAGE_KIND=hdd\nCOMPOSE_PROFILES=hdd\nHDD_ROOT=/var/lib/furan/storage\n";
  const extra = [
    `FURAN_BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_EMAIL}`,
    `FURAN_BOOTSTRAP_ADMIN_PASSWORD=${BOOTSTRAP_PASSWORD}`,
    // CORS: the stack's origin (3011; same-origin there, but browsers still
    // send Origin on POSTs) plus the visual sweep's dashboard dev server
    // (3012), which calls this api cross-origin from the browser.
    "FURAN_DASHBOARD_ORIGIN=http://localhost:3011,http://localhost:3012",
    "",
  ].join("\n");
  const path = join(tmpdir(), `furan-e2e-${mode}.env`);
  writeFileSync(path, `${base}\n${overlay}${extra}`);
  return path;
}

function compose(envFile: string, args: string[]): ReturnType<typeof execa> {
  return execa(
    "docker",
    [
      "compose",
      "-p",
      PROJECT,
      "--env-file",
      envFile,
      ...COMPOSE_FILES,
      ...args,
    ],
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
