import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Storage } from "@furan/storage";
import postgres from "postgres";

import type { ScaleEnv, ScaleS3Env } from "../env.js";
import { InterruptedError } from "../errors.js";

import type { StorageLocation } from "./process-env.js";
import { closeInOrder, type Teardown } from "./teardown.js";

/**
 * The harness's object storage: a bucket of its own (`furan-scale-<8 hex>`) on
 * the S3 endpoint, or a temporary directory for `--storage=hdd`. Both go when
 * the run ends, unless `--keep`.
 *
 * A kept database refers to the objects of the run that seeded it, so a kept
 * run also keeps its storage and records where it is in the scratch database
 * (outside `public`, which a reseed wipes). A `--reuse` run finds it there.
 *
 * Whatever kept location a run does not take over is that run's to remove: the
 * run either re-attaches it (`--reuse`) or replaces it, and a database that
 * is dropped or re-recorded would otherwise orphan it for good.
 */

export interface PreparedStorage {
  location: StorageLocation;
  /** True when a kept location from an earlier run is in use again. */
  reused: boolean;
}

const KEPT_SCHEMA = "scale_harness";

async function onScratch<T>(
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

/** The storage a `--keep` run left in the scratch database, if any. */
export async function readKept(
  url: string,
): Promise<StorageLocation | undefined> {
  return onScratch(url, async (sql) => {
    const [exists] = await sql<{ t: string | null }[]>`
      select to_regclass(${`${KEPT_SCHEMA}.storage`})::text as t`;
    if (!exists?.t) return undefined;
    const [row] = await sql<{ kind: string; location: string }[]>`
      select kind, location from scale_harness.storage limit 1`;
    if (row?.kind === "s3") return { kind: "s3", bucket: row.location };
    if (row?.kind === "hdd") return { kind: "hdd", root: row.location };
    return undefined;
  });
}

export async function writeKept(
  url: string,
  location: StorageLocation,
): Promise<void> {
  await onScratch(url, async (sql) => {
    await sql.unsafe(`create schema if not exists ${KEPT_SCHEMA}`);
    await sql.unsafe(
      `create table if not exists ${KEPT_SCHEMA}.storage (kind text not null, location text not null)`,
    );
    await sql`delete from scale_harness.storage`;
    await sql`insert into scale_harness.storage (kind, location)
      values (${location.kind}, ${location.kind === "s3" ? location.bucket : location.root})`;
  });
}

/**
 * Drops the seed's `scale_meta` table, so the next run rebuilds the seed
 * (its objects are gone or replaced; a kept database must never look current
 * while pointing at storage it no longer has).
 */
export async function forgetSeed(url: string): Promise<void> {
  await onScratch(url, async (sql) => {
    await sql.unsafe("drop table if exists public.scale_meta");
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DELETE_ATTEMPTS = 3;

/** The part of the AWS client the harness uses (so tests can fake it). */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
  destroy(): void;
}

function s3Client(s3: ScaleS3Env): S3Like {
  const client = new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
    forcePathStyle: true,
  });
  return {
    send: (command) => client.send(command as never),
    destroy: () => client.destroy(),
  };
}

/** What `prepareStorage` needs from outside; the defaults are the real ones. */
export interface StorageDeps {
  readKept(url: string): Promise<StorageLocation | undefined>;
  writeKept(url: string, location: StorageLocation): Promise<void>;
  forgetSeed(url: string): Promise<void>;
  s3Client(s3: ScaleS3Env): S3Like;
  makeTempDir(): Promise<string>;
}

const realDeps: StorageDeps = {
  readKept,
  writeKept,
  forgetSeed,
  s3Client,
  makeTempDir: () => mkdtemp(join(tmpdir(), "furan-scale-")),
};

const isNamed = (error: unknown, name: string): boolean =>
  (error as { name?: string }).name === name;

const send = async <T>(client: S3Like, command: unknown): Promise<T> =>
  (await client.send(command)) as T;

interface ListPage {
  Contents?: { Key?: string }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

/** Deletes every object of `bucket`, a page of 1,000 at a time. */
async function emptyBucket(client: S3Like, bucket: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await send<ListPage>(
      client,
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).flatMap((o) =>
      o.Key === undefined ? [] : [{ Key: o.Key }],
    );
    if (keys.length > 0) {
      const deleted = await send<{ Errors?: unknown[] }>(
        client,
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      if ((deleted.Errors?.length ?? 0) > 0) {
        throw new Error(`could not delete ${deleted.Errors?.length} objects`);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
}

/**
 * Empties and removes the bucket. A write that was already in flight when the
 * run was interrupted can land after the first pass, so a bucket that is not
 * empty yet is emptied again. A bucket that is already gone is done.
 */
async function removeBucket(client: S3Like, bucket: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await emptyBucket(client, bucket);
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      if (isNamed(error, "NoSuchBucket")) return;
      if (!isNamed(error, "BucketNotEmpty") || attempt >= DELETE_ATTEMPTS) {
        throw error;
      }
      await sleep(500);
    }
  }
}

async function bucketExists(client: S3Like, bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A recorded location is only ever removed if it is one this harness makes: a
 * `furan-scale-<8 hex>` bucket, or a `furan-scale-*` directory directly in the
 * temp dir. The record is data in a database: a wrong or hand-edited one must
 * never point a delete at somebody else's bucket or directory.
 */
export function ownedByHarness(
  location: StorageLocation | undefined,
): StorageLocation | undefined {
  if (location === undefined) return undefined;
  if (location.kind === "s3") {
    return /^furan-scale-[0-9a-f]{8}$/.test(location.bucket)
      ? location
      : undefined;
  }
  const root = resolve(location.root);
  return dirname(root) === resolve(tmpdir()) &&
    basename(root).startsWith("furan-scale-")
    ? location
    : undefined;
}

/**
 * Creates (or, for `--reuse`, finds again) the run's storage and registers
 * its removal on `teardown`. Call it after the scratch database exists.
 *
 * The kept location of an earlier run (the record in the scratch database) is
 * handled whichever flags this run has:
 * - `--reuse` and it still exists, on the same kind of storage: this run uses
 *   it again, and (unless `--keep`) removes it at the end;
 * - otherwise this run makes its own, and removes the earlier one at the end,
 *   because the database's record is overwritten (`--keep`) or the database is
 *   dropped (no `--keep`), after which nothing could find it again. The seed it
 *   belonged to is forgotten too, so a run interrupted before the reseed cannot
 *   leave a kept database that looks current but points at other storage.
 */
export async function prepareStorage(
  env: ScaleEnv,
  scratchDbUrl: string,
  teardown: Teardown,
  opts: { keep: boolean; reuse: boolean },
  deps: StorageDeps = realDeps,
): Promise<PreparedStorage> {
  const kept = ownedByHarness(await deps.readKept(scratchDbUrl));

  let client: S3Like | undefined;
  const clientFor = (): S3Like | undefined => {
    if (env.s3 === undefined) return undefined;
    client ??= deps.s3Client(env.s3);
    return client;
  };

  async function exists(candidate: StorageLocation): Promise<boolean> {
    if (candidate.kind === "hdd") return directoryExists(candidate.root);
    const c = clientFor();
    return c !== undefined && bucketExists(c, candidate.bucket);
  }

  async function remove(target: StorageLocation): Promise<void> {
    if (target.kind === "hdd") {
      await rm(target.root, { recursive: true, force: true });
      return;
    }
    const c = clientFor();
    if (c === undefined) {
      throw new Error(
        `kept bucket ${target.bucket} was not removed: SCALE_S3_* is not set`,
      );
    }
    await removeBucket(c, target.bucket);
  }

  let location: StorageLocation;
  let reused = false;
  try {
    const reattach =
      opts.reuse && kept !== undefined && kept.kind === env.storage
        ? await exists(kept)
        : false;
    if (reattach && kept !== undefined) {
      location = kept;
      reused = true;
    } else if (env.storage === "s3") {
      const created = clientFor();
      if (created === undefined)
        throw new Error("s3 storage without SCALE_S3_*");
      const bucket = `furan-scale-${randomBytes(4).toString("hex")}`;
      await created.send(new CreateBucketCommand({ Bucket: bucket }));
      location = { kind: "s3", bucket };
    } else {
      location = { kind: "hdd", root: await deps.makeTempDir() };
    }
  } catch (error) {
    client?.destroy();
    throw error;
  }

  // The earlier kept location, when this run does not take it over.
  const orphan = reused ? undefined : kept;
  // Kept only once the record says where it is; until then it is this run's
  // to remove, so an interrupt (or a failed write) cannot leak it.
  let keepCurrent = false;
  const describe = (l: StorageLocation): string =>
    l.kind === "s3" ? `bucket ${l.bucket}` : l.root;
  // One step: the client must outlive every removal.
  const removals = [
    ...(opts.keep ? [] : [describe(location)]),
    ...(orphan === undefined ? [] : [`kept ${describe(orphan)}`]),
  ];
  teardown.add(
    removals.length > 0
      ? `remove storage (${removals.join(", ")})`
      : "close the storage client",
    () =>
      closeInOrder(
        async () => {
          if (!keepCurrent) await remove(location);
        },
        async () => {
          if (orphan !== undefined) await remove(orphan);
        },
        async () => client?.destroy(),
      ),
  );

  if (!reused) await deps.forgetSeed(scratchDbUrl);
  if (opts.keep) {
    await deps.writeKept(scratchDbUrl, location);
    keepCurrent = true;
  }
  return { location, reused };
}

/**
 * A storage that refuses new work once the teardown has begun, so an
 * interrupted seed stops writing objects the teardown is about to remove.
 */
export function guardStorage(inner: Storage, teardown: Teardown): Storage {
  const open =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (teardown.closing) return Promise.reject(new InterruptedError());
      return fn(...args);
    };
  return {
    put: open((...a: Parameters<Storage["put"]>) => inner.put(...a)),
    putMultipart: open((...a: Parameters<Storage["putMultipart"]>) =>
      inner.putMultipart(...a),
    ),
    get: open((...a: Parameters<Storage["get"]>) => inner.get(...a)),
    head: open((...a: Parameters<Storage["head"]>) => inner.head(...a)),
    delete: open((...a: Parameters<Storage["delete"]>) => inner.delete(...a)),
    list: open((...a: Parameters<Storage["list"]>) => inner.list(...a)),
  };
}
