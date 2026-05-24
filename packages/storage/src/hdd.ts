import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HeadResult, Storage } from "./types.js";

export interface HddConfig {
  /**
   * Absolute filesystem root under which every object is stored. Resolved
   * via `path.resolve` so the runtime working directory does not change
   * where objects land. The factory ensures this is set before calling
   * `createHddStorage`.
   */
  root: string;
}

/**
 * Reject keys that would escape the storage root or otherwise reach
 * outside the intended subtree. The S3 backend accepts the same shape
 * harmlessly (S3 keys are flat strings), but on a filesystem these
 * patterns are a real path-traversal hazard.
 *
 * Allowed: relative paths with `/` separators, no `..` segments, no
 * leading `/` or platform-absolute prefix.
 */
function safeJoin(root: string, key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("storage_hdd_invalid_key: key must be a non-empty string");
  }
  if (path.isAbsolute(key)) {
    throw new Error("storage_hdd_invalid_key: absolute key paths are rejected");
  }
  // Normalize and ensure no `..` escapes. `path.resolve` then `startsWith`
  // is the canonical traversal check; using just `path.join` would let
  // `../etc/passwd` through.
  const resolved = path.resolve(root, key);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("storage_hdd_invalid_key: key would escape storage root");
  }
  return resolved;
}

/**
 * Filesystem-backed Storage. Mirrors the legacy NestJS `HddService` for
 * single-host installs that want to skip MinIO.
 *
 * Design choices:
 *  - `putMultipart` collapses to the same single `writeFile` as `put` —
 *    chunking is a network concern, not a disk one. Documented in the
 *    `Storage` interface comment.
 *  - No content-type metadata is persisted alongside files. `head`
 *    returns size only; consumers that need the original MIME look it up
 *    elsewhere (typically inferred from the key suffix or the DB row).
 *    This matches the legacy HDD behavior — keeping the surface small.
 *  - `delete` uses `rm(force: true)` so a missing object is not an
 *    error, matching S3 semantics.
 *  - Writes mkdir the parent on demand. Cheap; lets keys with embedded
 *    `/` separators (e.g. `screenshots/<hash>.png`) work without
 *    consumers having to pre-create dirs.
 *
 * Spec: furan-design/specs/2026-05-24-hdd-storage-backend-design.md
 */
export function createHddStorage(config: HddConfig): Storage {
  const root = path.resolve(config.root);

  const write = async (
    key: string,
    body: Buffer | Uint8Array,
  ): Promise<void> => {
    const filePath = safeJoin(root, key);
    await mkdir(path.dirname(filePath), { recursive: true });
    // `writeFile` accepts both Buffer and Uint8Array; callers pass either
    // depending on which SDK API gave them the bytes. Either way the
    // bytes are written verbatim — no PNG validation here (the legacy
    // service used `pngjs` to sanity-check, but that conflates storage
    // with content semantics; furan's capture path validates upstream).
    await writeFile(filePath, body);
  };

  return {
    async put(key, body, _contentType) {
      await write(key, body);
    },
    async putMultipart(key, body, _contentType) {
      // Single writeFile is correct for HDD — see interface comment.
      await write(key, body);
    },
    async get(key) {
      const filePath = safeJoin(root, key);
      const buf = await readFile(filePath);
      // Return a Uint8Array view to match the S3 backend's return type
      // exactly; Node's Buffer extends Uint8Array but explicit narrowing
      // keeps the consumer surface stable.
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async head(key) {
      const filePath = safeJoin(root, key);
      try {
        const st = await stat(filePath);
        const result: HeadResult = { size: st.size };
        return result;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) {
      const filePath = safeJoin(root, key);
      // `force: true` keeps the missing-key case silent, matching S3's
      // DeleteObject which is idempotent.
      await rm(filePath, { force: true });
    },
  };
}
