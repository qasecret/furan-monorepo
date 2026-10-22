/**
 * Environment for the scale harness.
 *
 * The harness runs next to a developer's own stack, on the same Postgres
 * server and Redis, so it reads only `SCALE_*` variables. It never reads
 * `DATABASE_URL`, `REDIS_URL` or `S3_*`: a shell that is set up for the dev
 * stack must not be able to point the harness at it by accident.
 */

/** The only database the harness creates, seeds and drops. */
export const SCRATCH_DATABASE = "furan_scale";

const DEFAULT_S3_REGION = "us-east-1";

export class ScaleEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaleEnvError";
  }
}

export interface ScaleS3Env {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface ScaleEnv {
  storage: "s3" | "hdd";
  /** Admin-capable URL for the Postgres server (not the scratch database). */
  databaseUrl: string;
  /** Optional non-owner role URL, rewritten onto the scratch database later. */
  databaseUrlApp?: string;
  redisUrl: string;
  /** Present for `storage: "s3"` only. */
  s3?: ScaleS3Env;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * Validates a connection string without echoing it: it carries a password, so
 * an error names only the variable.
 */
const checkUrl = (
  name: string,
  value: string,
  protocols: readonly string[],
): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ScaleEnvError(`${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    const expected = protocols.map((p) => `${p}//`).join(" or ");
    throw new ScaleEnvError(`${name} must be a ${expected} URL`);
  }
  return url;
};

/** The database name of a connection string, decoded. */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

export function parseScaleEnv(
  raw: NodeJS.ProcessEnv,
  flags: { storage: "s3" | "hdd" },
): ScaleEnv {
  const required = ["SCALE_DATABASE_URL", "SCALE_REDIS_URL"];
  if (flags.storage === "s3") {
    required.push(
      "SCALE_S3_ENDPOINT",
      "SCALE_S3_ACCESS_KEY",
      "SCALE_S3_SECRET_KEY",
    );
  }
  const missing = required.filter((name) => clean(raw[name]) === undefined);
  if (missing.length > 0) {
    throw new ScaleEnvError(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "The scale harness reads only SCALE_* variables, never DATABASE_URL, " +
        "REDIS_URL or S3_*, so it cannot touch a dev stack by accident.",
    );
  }
  // Presence was checked above, so these are all defined.
  const get = (name: string): string => clean(raw[name]) as string;

  const databaseUrl = get("SCALE_DATABASE_URL");
  checkUrl("SCALE_DATABASE_URL", databaseUrl, ["postgres:", "postgresql:"]);
  if (databaseName(databaseUrl) === SCRATCH_DATABASE) {
    throw new ScaleEnvError(
      `SCALE_DATABASE_URL must name an admin database such as "postgres", not ` +
        `${SCRATCH_DATABASE}: the harness creates, seeds and drops ` +
        `${SCRATCH_DATABASE} itself.`,
    );
  }

  const redisUrl = get("SCALE_REDIS_URL");
  checkUrl("SCALE_REDIS_URL", redisUrl, ["redis:", "rediss:"]);

  const env: ScaleEnv = { storage: flags.storage, databaseUrl, redisUrl };

  const appUrl = clean(raw["SCALE_DATABASE_URL_APP"]);
  if (appUrl !== undefined) {
    checkUrl("SCALE_DATABASE_URL_APP", appUrl, ["postgres:", "postgresql:"]);
    env.databaseUrlApp = appUrl;
  }

  if (flags.storage === "s3") {
    env.s3 = {
      endpoint: get("SCALE_S3_ENDPOINT"),
      accessKey: get("SCALE_S3_ACCESS_KEY"),
      secretKey: get("SCALE_S3_SECRET_KEY"),
      region: clean(raw["SCALE_S3_REGION"]) ?? DEFAULT_S3_REGION,
    };
  }
  return env;
}

/**
 * Points a connection string at another database on the same server. User,
 * password, host, port and query are kept as they were written.
 */
export function scratchUrl(url: string, db: string = SCRATCH_DATABASE): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(db)}`;
  return parsed.toString();
}
