import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { promisify } from "node:util";

import postgres from "postgres";

import { SCRATCH_DATABASE, scratchUrl } from "../env.js";

/**
 * The scratch database on the server `SCALE_DATABASE_URL` points at (spec §4).
 *
 * One harness run at a time per server: `createScratch` holds a session-level
 * advisory lock for the whole run, so a second run refuses instead of
 * clobbering `furan_scale` under the first. Advisory locks are scoped to the
 * database a session is connected to, so the lock is always taken on the
 * server's `postgres` database (Ruling R9), whichever admin database
 * `SCALE_DATABASE_URL` names. Not `template1`: a session held there makes
 * every CREATE DATABASE fail ("source database is being accessed").
 */

/** Minimum free disk before seeding a local server (spec §3.4). */
export const MIN_FREE_GIB = 10;

/** Errors raised here carry fixed text: never a URL, host or password. */
export class ScaleBusyError extends Error {
  constructor() {
    super(`another scale run holds ${SCRATCH_DATABASE} on this server`);
    this.name = "ScaleBusyError";
  }
}

export class ScaleDiskError extends Error {
  constructor(freeGiB: number) {
    super(
      `less than ${MIN_FREE_GIB} GiB free on / (${freeGiB.toFixed(1)} GiB); not seeding`,
    );
    this.name = "ScaleDiskError";
  }
}

export class ScaleScratchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaleScratchError";
  }
}

export interface Scratch {
  /** Connection string of `furan_scale` (carries the password: never print). */
  url: string;
  /** Frees the advisory lock and closes the admin connection. */
  release(): Promise<void>;
  /** Drops `furan_scale`. Call it before `release()`. */
  drop(): Promise<void>;
}

/** The lock every harness run takes on the server. */
const LOCK_KEY = "furan-scale";
/** The database every run takes `LOCK_KEY` in, so the lock is server-wide. */
const LOCK_DATABASE = "postgres";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function freeGiB(): number {
  const s = statfsSync("/");
  return (s.bavail * s.bsize) / 2 ** 30;
}

const execFileAsync = promisify(execFile);

/**
 * Applies the migrations to `url` in a child process. `DATABASE_URL` is set in
 * the child's environment only. The child's output can name the connection,
 * so a failure reports the exit status alone.
 */
async function migrate(url: string): Promise<void> {
  try {
    await execFileAsync(
      "pnpm",
      ["--filter", "@furan/db", "exec", "drizzle-kit", "migrate"],
      {
        env: { ...process.env, DATABASE_URL: url },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new ScaleScratchError(
      `drizzle-kit migrate failed (exit ${typeof code === "number" ? code : "?"})`,
    );
  }
}

/**
 * Takes the run lock, checks the disk (local servers only), creates
 * `furan_scale` if it is missing and migrates it.
 *
 * @throws ScaleBusyError when another run holds the lock.
 * @throws ScaleDiskError when a local server has less than 10 GiB free.
 */
export async function createScratch(adminUrl: string): Promise<Scratch> {
  const single = {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 0,
    max_lifetime: null,
    onnotice: () => {},
  } as const;
  // One connection each, so the session lock lives exactly as long as `lock`
  // does. `admin` creates and drops furan_scale.
  const lock = postgres(scratchUrl(adminUrl, LOCK_DATABASE), single);
  const admin = postgres(adminUrl, single);
  const unlock = () => lock`select pg_advisory_unlock(hashtext(${LOCK_KEY}))`;
  const closeAll = async () => {
    await Promise.allSettled([lock.end(), admin.end()]);
  };
  let locked = false;
  try {
    const [row] = await lock<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtext(${LOCK_KEY})) as locked`;
    locked = row?.locked === true;
    if (!locked) throw new ScaleBusyError();

    if (LOCAL_HOSTS.has(new URL(adminUrl).hostname)) {
      const free = freeGiB();
      if (free < MIN_FREE_GIB) throw new ScaleDiskError(free);
    }

    const found = await admin`
      select 1 from pg_database where datname = ${SCRATCH_DATABASE}`;
    if (found.length === 0) {
      await admin.unsafe(`create database ${SCRATCH_DATABASE}`);
    }
    const url = scratchUrl(adminUrl);
    await migrate(url);

    let released = false;
    return {
      url,
      async drop() {
        if (released) {
          // Without the lock another run may own furan_scale by now.
          throw new ScaleScratchError(
            `drop() after release(): ${SCRATCH_DATABASE} may belong to another run`,
          );
        }
        await admin.unsafe(
          `drop database if exists ${SCRATCH_DATABASE} with (force)`,
        );
      },
      async release() {
        if (released) return;
        released = true;
        try {
          await unlock();
        } finally {
          await closeAll();
        }
      },
    };
  } catch (e) {
    if (locked) await unlock().catch(() => {});
    await closeAll();
    throw e;
  }
}
