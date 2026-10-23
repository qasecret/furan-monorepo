import type { DiffErrorCode } from "@furan/db";
import { DiffEngineError } from "@furan/diff-engine";

/** How far down an error's `cause` chain to look. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The error and its causes, outermost first. Drizzle wraps the driver's error,
 * fetch wraps the socket's, and the diff engine wraps the library's, so what
 * identifies a failure is often a layer or two down.
 */
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let e = err;
  for (let depth = 0; e && depth < MAX_CAUSE_DEPTH; depth++) {
    chain.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * A Postgres error's SQLSTATE (`code`), on the error or on one of its causes
 * (Drizzle wraps the driver's error).
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (const e of errorChain(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const field = (e: unknown, key: string): unknown =>
  e !== null && typeof e === "object"
    ? (e as Record<string, unknown>)[key]
    : undefined;

/**
 * What the image decoders say about a PNG they cannot read: sharp (libvips on
 * libpng or libspng), pngjs (under pixelmatch and looks-same) and odiff
 * (libspng). None of them sets a `code`, so the message is all there is to go
 * on; the table test in `step-failure.test.ts` feeds each of them the bytes
 * that provoke these, so a library that rewords one fails it.
 */
const UNREADABLE_IMAGE = new RegExp(
  [
    // sharp
    "unsupported image format",
    "Input Buffer is empty",
    "Input buffer has corrupt header",
    "vipspng",
    "pngload",
    "libpng",
    // pngjs
    "unrecognised content at end of stream",
    "read requests waitng on finished stream",
    "Invalid file signature",
    "Crc error",
    "Unrecognised filter type",
    "Unsupported (?:critical chunk type|bit depth|color type)",
    "Unexpected end of input",
    "bad png",
    // odiff
    "libspng",
    "spng_\\w+",
    'Failure\\("end of stream"\\)',
  ].join("|"),
  "i",
);

function isTimeout(e: unknown): boolean {
  const name = field(e, "name");
  const code = field(e, "code");
  return (
    // Postgres query_canceled: a statement timeout.
    code === "57014" ||
    code === "ETIMEDOUT" ||
    name === "AbortError" ||
    name === "TimeoutError"
  );
}

function isUnreadableImage(e: unknown): boolean {
  const message = field(e, "message");
  return typeof message === "string" && UNREADABLE_IMAGE.test(message);
}

/**
 * A storage object that is not there, as the two backends report it:
 * `@aws-sdk/client-s3` names the error `NoSuchKey` (or `NotFound`, for a 404
 * without a body, always with its `$metadata`), and the HDD backend lets
 * `fs`'s ENOENT through. A spawn's ENOENT is a missing binary, not an object,
 * and a 404 from anything else (a missing bucket, a model provider) is neither.
 */
function isObjectMissing(e: unknown): boolean {
  const name = field(e, "name");
  if (name === "NoSuchKey") return true;
  if (name === "NotFound" && field(e, "$metadata") !== undefined) return true;
  const syscall = field(e, "syscall");
  return (
    field(e, "code") === "ENOENT" &&
    !(typeof syscall === "string" && syscall.startsWith("spawn"))
  );
}

/**
 * The reason code (`screenshots.diff_error`, spec 2026-10-23 §6) for the error
 * that failed a step's diff. Never the message: that is logged, not stored.
 *
 * The first rule that fits any error in the cause chain wins, most specific
 * first:
 *  1. `timeout`: Postgres 57014 (a statement timeout), `AbortError`,
 *     `TimeoutError`, `ETIMEDOUT`;
 *  2. `image_unreadable`: a decoder could not read the PNG, whether sharp in
 *     the worker or pngjs and odiff inside the engine;
 *  3. `engine_error` / `vlm_error`: a `DiffEngineError` from `@furan/diff-engine`
 *     names the stage that threw it. (Today a vision-model provider's failure
 *     never leaves `runVlm`, which folds it into the L1 verdict, so only a
 *     stage-tagged error from a future strict path reaches `vlm_error`);
 *  4. `object_missing`: a storage object that is not there. After the engine
 *     rule, so an ENOENT inside the engine (its temp files) stays the engine's;
 *  5. `internal`: anything else.
 */
export function classifyDiffError(err: unknown): DiffErrorCode {
  const chain = errorChain(err);
  if (chain.some(isTimeout)) return "timeout";
  if (chain.some(isUnreadableImage)) return "image_unreadable";
  const staged = chain.find((e) => e instanceof DiffEngineError);
  if (staged instanceof DiffEngineError) {
    return staged.stage === "vlm" ? "vlm_error" : "engine_error";
  }
  if (chain.some(isObjectMissing)) return "object_missing";
  return "internal";
}
