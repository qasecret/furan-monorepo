import { z } from "zod";

/**
 * API token (`furan_pat_*`) scopes and lifetimes (ADR-064 step B), shared by
 * the API and the dashboard.
 *
 * DB source of truth is `tokens.scopes` (`packages/db/src/schema/tokens.ts`,
 * closed set enforced by `tokens_scopes_chk`).
 *
 * - `sdk`: what the SDK and CI need: create builds and runs, upload
 *   screenshots, complete/abort runs, merge branch baselines, and read
 *   projects, builds, runs and their images. Its approve accepts only
 *   checkpoints with no baseline yet (`saveNewTests`), never a change.
 * - `read`: the read-only part of `sdk`.
 * - `legacy`: a token minted before scopes existed. Keeps the step-A
 *   behaviour (every project the owner can reach, any approve) until it
 *   expires; it can't be minted.
 *
 * No scope reaches token management or admin features; those need a session.
 */
export const mintableTokenScopeSchema = z.enum(["sdk", "read"]);
export type MintableTokenScope = z.infer<typeof mintableTokenScopeSchema>;

export const tokenScopeSchema = z.enum(["legacy", "sdk", "read"]);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

/** The lifetimes the dashboard offers, in days. */
export const TOKEN_LIFETIME_DAYS = [7, 30, 90, 180, 365] as const;

/** A new token's lifetime when the caller doesn't pick one, in days. */
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;
