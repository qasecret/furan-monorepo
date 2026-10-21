import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import type { ScaleEnv } from "../env.js";
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
async function readKept(url: string): Promise<StorageLocation | undefined> {
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

async function writeKept(
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DELETE_ATTEMPTS = 3;

/** Deletes every object of `bucket`, a page of 1,000 at a time. */
async function emptyBucket(client: S3Client, bucket: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).flatMap((o) =>
      o.Key === undefined ? [] : [{ Key: o.Key }],
    );
    if (keys.length > 0) {
      const deleted = await client.send(
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
 * empty yet is emptied again.
 */
async function removeBucket(client: S3Client, bucket: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await emptyBucket(client, bucket);
    try {
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NoSuchBucket") return;
      if (name !== "BucketNotEmpty" || attempt >= DELETE_ATTEMPTS) throw error;
      await sleep(500);
    }
  }
}

async function bucketExists(
  client: S3Client,
  bucket: string,
): Promise<boolean> {
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
 * Creates (or, for `--reuse`, finds again) the run's storage and registers
 * its removal on `teardown`. Call it after the scratch database exists.
 */
export async function prepareStorage(
  env: ScaleEnv,
  scratchDbUrl: string,
  teardown: Teardown,
  opts: { keep: boolean; reuse: boolean },
): Promise<PreparedStorage> {
  const previous = opts.reuse ? await readKept(scratchDbUrl) : undefined;
  let prepared: PreparedStorage;

  if (env.storage === "s3") {
    const s3 = env.s3;
    if (s3 === undefined) throw new Error("s3 storage without SCALE_S3_*");
    const client = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
      forcePathStyle: true,
    });

    let bucket: string;
    let reused = false;
    try {
      if (
        previous?.kind === "s3" &&
        (await bucketExists(client, previous.bucket))
      ) {
        bucket = previous.bucket;
        reused = true;
      } else {
        bucket = `furan-scale-${randomBytes(4).toString("hex")}`;
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    } catch (error) {
      client.destroy();
      throw error;
    }
    // One step: the client must outlive the bucket's removal.
    teardown.add(
      opts.keep ? "close the S3 client" : `remove bucket ${bucket}`,
      () =>
        closeInOrder(
          async () => {
            if (!opts.keep) await removeBucket(client, bucket);
          },
          async () => client.destroy(),
        ),
    );
    prepared = { location: { kind: "s3", bucket }, reused };
  } else {
    let root: string;
    let reused = false;
    if (previous?.kind === "hdd" && (await directoryExists(previous.root))) {
      root = previous.root;
      reused = true;
    } else {
      root = await mkdtemp(join(tmpdir(), "furan-scale-"));
    }
    if (!opts.keep) {
      teardown.add(`remove ${root}`, () =>
        rm(root, { recursive: true, force: true }),
      );
    }
    prepared = { location: { kind: "hdd", root }, reused };
  }

  if (opts.keep) await writeKept(scratchDbUrl, prepared.location);
  return prepared;
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
