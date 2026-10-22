import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { SCRATCH_DATABASE, scratchUrl } from "../src/env.js";
import {
  MIN_FREE_GIB,
  ScaleBusyError,
  ScaleDiskError,
  checkFreeDisk,
  createScratch,
} from "../src/seed/scratch.js";
import { shapes } from "../src/seed/shape.js";

/**
 * Integration tests against the test Postgres named by SCALE_DATABASE_URL (an
 * admin database such as `postgres`, never a dev stack). Skipped when it is
 * not set, so the package's plain `pnpm test` needs no services.
 *
 * Connection strings carry a password, so no assertion here ever compares or
 * prints one: a failing matcher prints its subject. URLs are checked through
 * their pathname only, and a `createScratch` that should have failed is
 * reduced to a fixed string before it reaches `expect`.
 */
const adminUrl = process.env.SCALE_DATABASE_URL;

/** These tests seed nothing: the smoke shape's disk requirement (Ruling R50). */
const SMOKE_DISK = { minFreeGiB: MIN_FREE_GIB.smoke };

/** A database this test creates on the same server, never furan_scale. */
const LOCK_TEST_DATABASE = "furan_scale_locktest";

async function onServer<T>(
  url: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function scratchExists(url: string): Promise<boolean> {
  return onServer(url, async (sql) => {
    const rows =
      await sql`select 1 from pg_database where datname = ${SCRATCH_DATABASE}`;
    return rows.length > 0;
  });
}

/**
 * The error a `createScratch(url)` throws, or the string "acquired" when it
 * succeeds (then released at once). Never the `Scratch` itself: its `url`
 * holds the password.
 */
async function attempt(url: string): Promise<unknown> {
  try {
    const scratch = await createScratch(url, SMOKE_DISK);
    await scratch.release();
    return "acquired";
  } catch (e) {
    return e;
  }
}

describe.skipIf(!adminUrl)("createScratch (test Postgres)", () => {
  const url = adminUrl as string;

  it("refuses a second concurrent run", async () => {
    const first = await createScratch(url, SMOKE_DISK);
    try {
      expect(new URL(first.url).pathname).toBe(`/${SCRATCH_DATABASE}`);
      const second = await attempt(url);
      expect(second).toBeInstanceOf(ScaleBusyError);
      expect((second as Error).message).toBe(
        "another scale run holds furan_scale on this server",
      );
    } finally {
      await first.drop();
      await first.release();
    }
    // Released: a new run may start.
    const next = await createScratch(url, SMOKE_DISK);
    await next.drop();
    await next.release();
  }, 180_000);

  it("refuses a second run whose admin URL names another database on the server", async () => {
    const otherUrl = scratchUrl(url, LOCK_TEST_DATABASE);
    await onServer(url, async (sql) => {
      await sql.unsafe(
        `drop database if exists ${LOCK_TEST_DATABASE} with (force)`,
      );
      await sql.unsafe(`create database ${LOCK_TEST_DATABASE}`);
    });
    const first = await createScratch(url, SMOKE_DISK);
    try {
      expect(await attempt(otherUrl)).toBeInstanceOf(ScaleBusyError);
    } finally {
      await first.drop();
      await first.release();
      await onServer(url, (sql) =>
        sql.unsafe(
          `drop database if exists ${LOCK_TEST_DATABASE} with (force)`,
        ),
      );
    }
  }, 180_000);

  it("drop removes the database", async () => {
    const scratch = await createScratch(url, SMOKE_DISK);
    try {
      expect(await scratchExists(url)).toBe(true);
      await scratch.drop();
      expect(await scratchExists(url)).toBe(false);
    } finally {
      await scratch.release();
    }
  }, 180_000);

  it("refuses to drop after release", async () => {
    const scratch = await createScratch(url, SMOKE_DISK);
    await scratch.drop();
    await scratch.release();
    await expect(scratch.drop()).rejects.toThrow(/after release/);
  }, 180_000);
});

describe("the free-disk guard (Ruling R50)", () => {
  const LOCAL = "postgres://admin:pw@localhost:55432/postgres";
  const LOOPBACK = "postgres://admin:pw@127.0.0.1:55432/postgres";
  const REMOTE = "postgres://admin:pw@db.internal:5432/postgres";

  it("asks 10 GiB for large and 1 GiB for smoke", () => {
    expect(MIN_FREE_GIB[shapes.large.name]).toBe(10);
    expect(MIN_FREE_GIB[shapes.smoke.name]).toBe(1);
  });

  it("refuses a local server below the shape's requirement, with a fixed message", () => {
    const refusal = (() => {
      try {
        checkFreeDisk(LOCAL, MIN_FREE_GIB.large, () => 9.54);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(ScaleDiskError);
    expect((refusal as Error).message).toBe(
      "less than 10 GiB free on / (9.5 GiB); not seeding",
    );
    expect(() =>
      checkFreeDisk(LOOPBACK, MIN_FREE_GIB.smoke, () => 0.5),
    ).toThrow("less than 1 GiB free on / (0.5 GiB); not seeding");
  });

  it("lets a smoke run through where only a large one is refused", () => {
    expect(() =>
      checkFreeDisk(LOCAL, MIN_FREE_GIB.smoke, () => 9.5),
    ).not.toThrow();
    // The requirement itself passes.
    expect(() =>
      checkFreeDisk(LOCAL, MIN_FREE_GIB.large, () => 10),
    ).not.toThrow();
  });

  it("does not check a remote server's disk at all", () => {
    let asked = false;
    checkFreeDisk(REMOTE, MIN_FREE_GIB.large, () => {
      asked = true;
      return 0;
    });
    expect(asked).toBe(false);
  });
});
