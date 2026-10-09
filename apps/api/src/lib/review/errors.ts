import type { ReviewErrorDetails } from "@furan/shared-types";
import { TRPCError } from "@trpc/server";

/**
 * The tRPC codes a review refusal may use. Narrower than `TRPC_ERROR_CODE_KEY`
 * on purpose: review refusals are always a client-visible "you can't do that
 * (right now)", never an internal failure.
 */
export type ReviewErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "PRECONDITION_FAILED";

/**
 * Carrier for a review refusal's structured payload. It rides on
 * `TRPCError.cause` so the `errorFormatter` in `trpc/trpc.ts` can lift it onto
 * `data.details` (per-checkpoint reasons, the race winner, a bulk preview)
 * without any other error's shape changing. Internal to the api: callers throw
 * {@link reviewError}; only the formatter needs to recognise this class.
 */
export class ReviewRefusal extends Error {
  readonly details: ReviewErrorDetails | undefined;

  constructor(message: string, details?: ReviewErrorDetails) {
    super(message);
    this.name = "ReviewRefusal";
    this.details = details;
  }
}

/**
 * Builds a `TRPCError` for a refused review action. The optional `details`
 * reach the client as `error.data.details` (typed as {@link ReviewErrorDetails}).
 */
export function reviewError(
  code: ReviewErrorCode,
  message: string,
  details?: ReviewErrorDetails,
): TRPCError {
  return new TRPCError({
    code,
    message,
    cause: new ReviewRefusal(message, details),
  });
}
