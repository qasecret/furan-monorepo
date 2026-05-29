/**
 * Vitest global setup: realign S3_ACCESS_KEY / S3_SECRET_KEY to the
 * running MinIO container's credentials. The shell `.env` ships with a
 * placeholder (`S3_SECRET_KEY=devpw_must_be_long`) but the dev compose
 * generates a random `MINIO_ROOT_PASSWORD` on first `up`. When the two
 * diverge every S3 round-trip returns SignatureDoesNotMatch (HTTP 403)
 * and all storage-touching diff-worker tests fail with no clear pointer.
 *
 * Logic mirrors `apps/api/tests/helpers.ts` — if a minio container is
 * reachable via `docker exec`, prefer its live creds; otherwise fall back
 * to whatever is already in process.env (CI has no docker socket).
 */
import { execSync } from "node:child_process";

function printenv(container: string, name: string): string | undefined {
  try {
    const out = execSync(`docker exec ${container} printenv ${name}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .toString("utf8")
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function realignMinioCredentials(): void {
  const candidates = ["docker-minio-1", "furan-minio-1", "minio"];
  for (const name of candidates) {
    const user = printenv(name, "MINIO_ROOT_USER");
    const password = printenv(name, "MINIO_ROOT_PASSWORD");
    if (!user || !password) continue;
    if (!process.env.S3_ACCESS_KEY || process.env.S3_ACCESS_KEY === "furan") {
      process.env.S3_ACCESS_KEY = user;
    }
    if (
      !process.env.S3_SECRET_KEY ||
      process.env.S3_SECRET_KEY === "devpw_must_be_long" ||
      password
    ) {
      process.env.S3_SECRET_KEY = password;
    }
    break;
  }
}

realignMinioCredentials();
