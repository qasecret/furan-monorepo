/**
 * Why a step's diff failed for good, as the worker records it
 * (`screenshots.diff_error`, spec 2026-10-23 §6): a fixed set of codes, never
 * a message. The dashboard holds its own copy of the list; it must not pull in
 * the database package.
 */
export const DIFF_ERROR_CODES = [
  "image_unreadable",
  "object_missing",
  "engine_error",
  "vlm_error",
  "timeout",
  "internal",
] as const;
export type DiffErrorCode = (typeof DIFF_ERROR_CODES)[number];

/** The reasons, verbatim from spec 2026-10-23 §10. */
const COPY = {
  image_unreadable: "The screenshot couldn't be read.",
  object_missing: "An image is missing from storage.",
  engine_error: "The comparison failed.",
  vlm_error: "The visual AI step failed.",
  timeout: "The diff didn't finish in time.",
  internal: "Something went wrong. Retry, or check the worker logs.",
} as const satisfies Record<DiffErrorCode, string>;

const isDiffErrorCode = (code: unknown): code is DiffErrorCode =>
  typeof code === "string" && Object.hasOwn(COPY, code);

/**
 * The code to show for what the server sent: a code from a newer worker, or
 * none, reads as `internal`.
 */
export function diffErrorCode(code: string | null | undefined): DiffErrorCode {
  return isDiffErrorCode(code) ? code : "internal";
}

/** The sentence that says why a step's diff failed. */
export function diffErrorCopy(code: string): string {
  return COPY[diffErrorCode(code)];
}
