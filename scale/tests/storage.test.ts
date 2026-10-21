import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseScaleEnv, type ScaleEnv } from "../src/env.js";
import type { StorageLocation } from "../src/stack/process-env.js";
import {
  ownedByHarness,
  prepareStorage,
  type S3Like,
  type StorageDeps,
} from "../src/stack/storage.js";
import { Teardown } from "../src/stack/teardown.js";

const base = {
  SCALE_DATABASE_URL: "postgres://admin:pw@localhost:55432/postgres",
  SCALE_REDIS_URL: "redis://localhost:56379",
};
const s3Env = (): ScaleEnv =>
  parseScaleEnv(
    {
      ...base,
      SCALE_S3_ENDPOINT: "http://localhost:59000",
      SCALE_S3_ACCESS_KEY: "ak",
      SCALE_S3_SECRET_KEY: "sk-long-enough",
    },
    { storage: "s3" },
  );
const hddEnv = (): ScaleEnv => parseScaleEnv(base, { storage: "hdd" });

/**
 * One fake server shared by consecutive "runs": the kept record in the scratch
 * database, the buckets on the S3 endpoint, and the temp directories.
 */
function world() {
  const state = {
    record: undefined as StorageLocation | undefined,
    buckets: new Map<string, Set<string>>(),
    forgot: 0,
    failWrite: false,
    dirs: [] as string[],
  };
  const named = (command: unknown) =>
    (command as { constructor: { name: string } }).constructor.name;
  const input = (command: unknown) =>
    (command as { input: Record<string, unknown> }).input;
  const s3: S3Like = {
    async send(command) {
      const { Bucket } = input(command) as { Bucket: string };
      const keys = state.buckets.get(Bucket);
      const fail = (name: string) => Object.assign(new Error(name), { name });
      switch (named(command)) {
        case "CreateBucketCommand":
          state.buckets.set(Bucket, new Set());
          return {};
        case "HeadBucketCommand":
          if (!keys) throw fail("NotFound");
          return {};
        case "ListObjectsV2Command":
          if (!keys) throw fail("NoSuchBucket");
          return { Contents: [...keys].map((Key) => ({ Key })) };
        case "DeleteObjectsCommand":
          for (const o of (
            input(command) as { Delete: { Objects: { Key: string }[] } }
          ).Delete.Objects) {
            keys?.delete(o.Key);
          }
          return {};
        case "DeleteBucketCommand":
          if (!keys) throw fail("NoSuchBucket");
          if (keys.size > 0) throw fail("BucketNotEmpty");
          state.buckets.delete(Bucket);
          return {};
        default:
          throw new Error(`unexpected command ${named(command)}`);
      }
    },
    destroy() {},
  };
  const deps: StorageDeps = {
    readKept: async () => state.record,
    writeKept: async (_url, location) => {
      if (state.failWrite) throw new Error("write failed");
      state.record = location;
    },
    forgetSeed: async () => {
      state.forgot += 1;
    },
    s3Client: () => s3,
    makeTempDir: async () => {
      const dir = await mkdtemp(join(tmpdir(), "furan-scale-"));
      state.dirs.push(dir);
      return dir;
    },
  };
  /** One harness run's storage: prepare it, then end the run. */
  const run = async (
    env: ScaleEnv,
    opts: { keep: boolean; reuse: boolean },
  ) => {
    const teardown = new Teardown();
    const prepared = await prepareStorage(env, "unused", teardown, opts, deps);
    // Something was seeded into it.
    if (prepared.location.kind === "s3") {
      state.buckets.get(prepared.location.bucket)?.add("image-1");
    }
    return {
      prepared,
      end: async () => (await teardown.run()).filter((r) => r.error),
    };
  };
  return { state, deps, run };
}

const dirExists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("kept S3 storage", () => {
  it("is removed by the next plain run, which also drops the record's database", async () => {
    const w = world();
    const first = await w.run(s3Env(), { keep: true, reuse: false });
    await first.end();
    const kept = first.prepared.location;
    expect(kept.kind).toBe("s3");
    expect([...w.state.buckets.keys()]).toHaveLength(1);

    // Scenario A: a plain run (no --reuse, no --keep).
    const second = await w.run(s3Env(), { keep: false, reuse: false });
    expect(await second.end()).toEqual([]);
    expect([...w.state.buckets.keys()]).toEqual([]);
    // The seed the kept bucket belonged to is not left looking current.
    expect(w.state.forgot).toBeGreaterThanOrEqual(2);
  });

  it("is removed when --keep runs again without --reuse, and only the new one stays", async () => {
    const w = world();
    const first = await w.run(s3Env(), { keep: true, reuse: false });
    await first.end();
    const a = first.prepared.location;

    // Scenario B: --keep twice.
    const second = await w.run(s3Env(), { keep: true, reuse: false });
    expect(await second.end()).toEqual([]);
    const b = second.prepared.location;
    expect(b).not.toEqual(a);
    expect([...w.state.buckets.keys()]).toEqual([
      (b as { bucket: string }).bucket,
    ]);
    expect(w.state.record).toEqual(b);
  });

  it("is used again by --reuse and left alone by --keep", async () => {
    const w = world();
    const first = await w.run(s3Env(), { keep: true, reuse: false });
    await first.end();
    const forgotBefore = w.state.forgot;

    const second = await w.run(s3Env(), { keep: true, reuse: true });
    expect(second.prepared.reused).toBe(true);
    expect(second.prepared.location).toEqual(first.prepared.location);
    expect(await second.end()).toEqual([]);
    expect([...w.state.buckets.keys()]).toHaveLength(1);
    // A re-attached seed is kept: it is not forgotten.
    expect(w.state.forgot).toBe(forgotBefore);
  });

  it("is used again by --reuse and removed at the end without --keep", async () => {
    const w = world();
    const first = await w.run(s3Env(), { keep: true, reuse: false });
    await first.end();

    const second = await w.run(s3Env(), { keep: false, reuse: true });
    expect(second.prepared.reused).toBe(true);
    expect(await second.end()).toEqual([]);
    expect([...w.state.buckets.keys()]).toEqual([]);
  });

  it("is replaced, not reused, when its bucket is gone", async () => {
    const w = world();
    const first = await w.run(s3Env(), { keep: true, reuse: false });
    await first.end();
    w.state.buckets.clear();

    const second = await w.run(s3Env(), { keep: false, reuse: true });
    expect(second.prepared.reused).toBe(false);
    expect(await second.end()).toEqual([]);
    expect([...w.state.buckets.keys()]).toEqual([]);
  });

  it("is not leaked when the record cannot be written", async () => {
    const w = world();
    w.state.failWrite = true;
    const teardown = new Teardown();
    await expect(
      prepareStorage(
        s3Env(),
        "unused",
        teardown,
        { keep: true, reuse: false },
        w.deps,
      ),
    ).rejects.toThrow("write failed");
    expect([...w.state.buckets.keys()]).toHaveLength(1);
    // The step reports no error, and the bucket it could not record is gone.
    expect((await teardown.run()).filter((r) => r.error)).toEqual([]);
    expect([...w.state.buckets.keys()]).toEqual([]);
  });

  it("is never a bucket the harness did not make", async () => {
    const w = world();
    w.state.buckets.set("furan-dev", new Set(["precious"]));
    w.state.record = { kind: "s3", bucket: "furan-dev" };

    const run = await w.run(s3Env(), { keep: false, reuse: true });
    expect(run.prepared.reused).toBe(false);
    await run.end();
    expect(w.state.buckets.get("furan-dev")).toEqual(new Set(["precious"]));
  });
});

describe("kept HDD storage", () => {
  const keptDirs = (w: ReturnType<typeof world>) => w.state.dirs;
  afterEach(async () => {
    // Anything a test left behind (a kept directory).
    for (const dir of created) await rm(dir, { recursive: true, force: true });
  });

  it("is removed by the next plain run", async () => {
    const w = world();
    const first = await w.run(hddEnv(), { keep: true, reuse: false });
    await first.end();
    const [a] = keptDirs(w);
    created.push(a!);
    expect(await dirExists(a!)).toBe(true);

    const second = await w.run(hddEnv(), { keep: false, reuse: false });
    expect(await second.end()).toEqual([]);
    for (const dir of keptDirs(w)) expect(await dirExists(dir)).toBe(false);
  });

  it("is removed when --keep runs again without --reuse", async () => {
    const w = world();
    const first = await w.run(hddEnv(), { keep: true, reuse: false });
    await first.end();
    const second = await w.run(hddEnv(), { keep: true, reuse: false });
    expect(await second.end()).toEqual([]);
    const [a, b] = keptDirs(w);
    created.push(a!, b!);
    expect(await dirExists(a!)).toBe(false);
    expect(await dirExists(b!)).toBe(true);
    expect(w.state.record).toEqual({ kind: "hdd", root: b });
  });

  it("is used again by --reuse", async () => {
    const w = world();
    const first = await w.run(hddEnv(), { keep: true, reuse: false });
    await first.end();
    const [a] = keptDirs(w);
    created.push(a!);
    const second = await w.run(hddEnv(), { keep: false, reuse: true });
    expect(second.prepared.reused).toBe(true);
    expect(keptDirs(w)).toEqual([a]);
    await second.end();
    expect(await dirExists(a!)).toBe(false);
  });

  it("is removed by an S3 run that does not take it over", async () => {
    const w = world();
    const first = await w.run(hddEnv(), { keep: true, reuse: false });
    await first.end();
    const [a] = keptDirs(w);
    created.push(a!);

    const second = await w.run(s3Env(), { keep: false, reuse: true });
    expect(second.prepared.reused).toBe(false);
    expect(await second.end()).toEqual([]);
    expect(await dirExists(a!)).toBe(false);
  });

  it("is never a directory outside the temp dir", async () => {
    const w = world();
    const outside = await mkdtemp(join(tmpdir(), "not-ours-"));
    created.push(outside);
    w.state.record = { kind: "hdd", root: outside };
    const run = await w.run(hddEnv(), { keep: false, reuse: false });
    await run.end();
    expect(await dirExists(outside)).toBe(true);
  });
});

describe("a kept bucket the run cannot reach", () => {
  it("is reported, not silently dropped, by a run without SCALE_S3_*", async () => {
    const w = world();
    const first = await w.run(s3Env(), { keep: true, reuse: false });
    await first.end();

    const second = await w.run(hddEnv(), { keep: false, reuse: false });
    const failed = await second.end();
    created.push(...w.state.dirs);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatch(
      /kept bucket furan-scale-[0-9a-f]{8} was not removed/,
    );
    // ...and the bucket is untouched.
    expect([...w.state.buckets.keys()]).toHaveLength(1);
  });
});

describe("ownedByHarness", () => {
  it("accepts only what this harness makes", () => {
    expect(ownedByHarness(undefined)).toBeUndefined();
    expect(
      ownedByHarness({ kind: "s3", bucket: "furan-scale-0a1b2c3d" }),
    ).toBeDefined();
    expect(ownedByHarness({ kind: "s3", bucket: "furan-dev" })).toBeUndefined();
    expect(
      ownedByHarness({ kind: "s3", bucket: "furan-scale-xyz" }),
    ).toBeUndefined();
    expect(ownedByHarness({ kind: "hdd", root: "/" })).toBeUndefined();
    expect(
      ownedByHarness({
        kind: "hdd",
        root: join(tmpdir(), "furan-scale-AbC123"),
      }),
    ).toBeDefined();
    expect(
      ownedByHarness({
        kind: "hdd",
        root: join(tmpdir(), "furan-scale-AbC123", "..", "x"),
      }),
    ).toBeUndefined();
  });
});
