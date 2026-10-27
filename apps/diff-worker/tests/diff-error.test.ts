import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DIFF_ERROR_CODES, type DiffErrorCode } from "@furan/db";
import {
  DEFAULT_ENGINE_CONFIG,
  DiffEngineError,
  ollamaProvider,
  runDiff,
  runL1,
} from "@furan/diff-engine";
import { createHddStorage } from "@furan/storage";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyDiffError } from "../src/diff-error.js";

import { rejection } from "./helpers/rejection.js";
import { square } from "./helpers/step-seed.js";

/**
 * `classifyDiffError` (spec 2026-10-23 §6): the reason code a step's diff
 * failure is stored under. Pure: no database, queue or object store, so it
 * runs anywhere. The rows that need the real Postgres and the real bucket are
 * in `step-failure.test.ts`.
 */

describe("classifyDiffError", () => {
  let hddRoot: string;
  let png: Buffer;
  beforeAll(async () => {
    hddRoot = mkdtempSync(join(tmpdir(), "furan-diff-error-"));
    png = await square("red", 0);
  });
  afterAll(() => rmSync(hddRoot, { recursive: true, force: true }));

  /** What `@aws-sdk/client-s3` throws: a plain error with `name` and `$metadata`. */
  const s3Error = (name: string, httpStatusCode: number): Error =>
    Object.assign(new Error(`${name}: the specified key does not exist.`), {
      name,
      Code: name,
      $metadata: { httpStatusCode },
    });

  // One group per code. The errors are the real ones wherever the libraries
  // allow: the fs, sharp, pngjs, odiff and AbortSignal errors below are thrown
  // by the libraries themselves; S3's is built to its documented shape (the
  // integration test in `step-failure.test.ts` reads a missing key from the
  // real bucket). libvips' write-side message is built to its documented text:
  // sharp has no realistic way to raise a libpng write error.
  const cases: Array<[string, DiffErrorCode, () => unknown]> = [
    // object_missing
    [
      "an HDD object that is not there (fs ENOENT)",
      "object_missing",
      () => rejection(createHddStorage({ root: hddRoot }).get("no/such.png")),
    ],
    [
      "an S3 GetObject on a missing key (NoSuchKey)",
      "object_missing",
      () => s3Error("NoSuchKey", 404),
    ],
    [
      "an S3 404 without a body (NotFound)",
      "object_missing",
      () => s3Error("NotFound", 404),
    ],
    [
      "a missing object nested as a cause",
      "object_missing",
      () => new Error("diff failed", { cause: s3Error("NoSuchKey", 404) }),
    ],
    // image_unreadable
    [
      "sharp on bytes that are not an image",
      "image_unreadable",
      () => rejection(sharp(Buffer.from("not a png")).metadata()),
    ],
    [
      "sharp on an empty buffer",
      "image_unreadable",
      // sharp refuses an empty buffer as it is constructed.
      () => rejection((async () => sharp(Buffer.alloc(0)).metadata())()),
    ],
    [
      "sharp decoding a truncated PNG (libpng)",
      "image_unreadable",
      () =>
        rejection(
          sharp(png.subarray(0, png.length - 30))
            .raw()
            .toBuffer(),
        ),
    ],
    [
      "pixelmatch's decoder (pngjs) on garbage, inside the engine",
      "image_unreadable",
      () =>
        rejection(
          runDiff({
            baseline: { image: Buffer.from("garbage") },
            candidate: { image: png },
            config: {
              diffThreshold: 0.001,
              engine: "pixelmatch",
              engineConfig: DEFAULT_ENGINE_CONFIG,
            },
          }),
        ),
    ],
    [
      "odiff (libspng) on a truncated PNG, inside the engine",
      "image_unreadable",
      () =>
        rejection(
          runL1(
            png,
            png.subarray(0, png.length - 30),
            undefined,
            "odiff",
            DEFAULT_ENGINE_CONFIG,
          ),
        ),
    ],
    // engine_error
    [
      "the pixel engine rejecting its input (an unknown engine)",
      "engine_error",
      () =>
        rejection(
          runL1(png, png, undefined, "nope" as never, DEFAULT_ENGINE_CONFIG),
        ),
    ],
    [
      "an fs ENOENT inside the engine (not a storage miss)",
      "engine_error",
      async () =>
        new DiffEngineError(
          "engine",
          await rejection(readFile(join(hddRoot, "odiff", "diff.png"))),
        ),
    ],
    // vlm_error
    [
      "a vision-model provider that is unreachable",
      "vlm_error",
      async () =>
        new DiffEngineError(
          "vlm",
          await rejection(
            ollamaProvider.generate(
              {
                provider: "ollama",
                model: "m",
                prompt: "p",
                temperature: 0,
                baseUrl: "http://127.0.0.1:1",
              },
              [],
            ),
          ),
        ),
    ],
    // timeout
    [
      "a timed-out signal (TimeoutError)",
      "timeout",
      async () => {
        const signal = AbortSignal.timeout(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return signal.reason;
      },
    ],
    [
      "an aborted request (AbortError)",
      "timeout",
      () => AbortSignal.abort().reason,
    ],
    [
      "a Postgres statement timeout (57014) under a driver wrapper",
      "timeout",
      () =>
        new Error("Failed query", {
          cause: Object.assign(
            new Error("canceling statement due to statement timeout"),
            { code: "57014" },
          ),
        }),
    ],
    // internal
    ["a plain error", "internal", () => new Error("boom")],
    ["a TypeError", "internal", () => new TypeError("x is not a function")],
    ["a thrown string", "internal", () => "boom"],
    ["nothing at all", "internal", () => undefined],
    [
      "a Postgres unique violation",
      "internal",
      () => Object.assign(new Error("duplicate key"), { code: "23505" }),
    ],
    [
      "sharp failing to write a PNG (the encode side, not a decode)",
      "internal",
      () =>
        rejection(sharp(png).toFile(join(hddRoot, "no-such-dir", "out.png"))),
    ],
    [
      // The read-side message, "libpng read error", is an unreadable image.
      "libvips' write-side libpng message",
      "internal",
      () => new Error("vips2png: libpng write error"),
    ],
    [
      "a spawn of a missing binary (ENOENT, but not a storage miss)",
      "internal",
      () => rejection(promisify(execFile)("furan-no-such-binary-xyz")),
    ],
    [
      "a missing bucket (a 404, but not a missing object)",
      "internal",
      () => s3Error("NoSuchBucket", 404),
    ],
    [
      "a provider's own 404 (no S3 metadata)",
      "internal",
      () => Object.assign(new Error("model not found"), { status: 404 }),
    ],
  ];

  it.each(cases)("%s -> %s", async (_name, expected, make) => {
    expect(classifyDiffError(await make())).toBe(expected);
  });

  it("has a case for every code", () => {
    expect(new Set(cases.map(([, code]) => code))).toEqual(
      new Set(DIFF_ERROR_CODES),
    );
  });

  describe("when more than one class fits, the more specific wins", () => {
    it("a timeout inside the engine is a timeout", async () => {
      const timeout = AbortSignal.abort().reason;
      expect(classifyDiffError(new DiffEngineError("engine", timeout))).toBe(
        "timeout",
      );
    });

    it("an unreadable image inside the engine is the image's fault", async () => {
      const err = await rejection(
        runL1(
          png,
          Buffer.from("garbage"),
          undefined,
          "looks_same",
          DEFAULT_ENGINE_CONFIG,
        ),
      );
      expect(err).toBeInstanceOf(DiffEngineError);
      expect(classifyDiffError(err)).toBe("image_unreadable");
    });

    it("an engine error is not a storage miss even when it wraps ENOENT", async () => {
      const enoent = await rejection(readFile(join(hddRoot, "missing.png")));
      expect(classifyDiffError(enoent)).toBe("object_missing");
      expect(classifyDiffError(new DiffEngineError("engine", enoent))).toBe(
        "engine_error",
      );
    });
  });
});
