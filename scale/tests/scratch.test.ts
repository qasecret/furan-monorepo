import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { SCRATCH_DATABASE } from "../src/env.js";
import { ScaleBusyError, createScratch } from "../src/seed/scratch.js";

/**
 * Integration tests against the test Postgres named by SCALE_DATABASE_URL (an
 * admin database such as `postgres`, never a dev stack). Skipped when it is
 * not set, so the package's plain `pnpm test` needs no services.
 */
const adminUrl = process.env.SCALE_DATABASE_URL;

async function scratchExists(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows =
      await sql`select 1 from pg_database where datname = ${SCRATCH_DATABASE}`;
    return rows.length > 0;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!adminUrl)("createScratch (test Postgres)", () => {
  const url = adminUrl as string;

  it("refuses a second concurrent run", async () => {
    const first = await createScratch(url);
    try {
      expect(first.url).toMatch(/\/furan_scale$/);
      await expect(createScratch(url)).rejects.toBeInstanceOf(ScaleBusyError);
      await expect(createScratch(url)).rejects.toThrow(
        "another scale run holds furan_scale on this server",
      );
    } finally {
      await first.drop();
      await first.release();
    }
    // Released: a new run may start.
    const next = await createScratch(url);
    await next.drop();
    await next.release();
  }, 180_000);

  it("drop removes the database", async () => {
    const scratch = await createScratch(url);
    try {
      expect(await scratchExists(url)).toBe(true);
      await scratch.drop();
      expect(await scratchExists(url)).toBe(false);
    } finally {
      await scratch.release();
    }
  }, 180_000);

  it("refuses to drop after release", async () => {
    const scratch = await createScratch(url);
    await scratch.drop();
    await scratch.release();
    await expect(scratch.drop()).rejects.toThrow(/after release/);
  }, 180_000);
});
