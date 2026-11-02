import type { DB } from "@furan/db";
import type { TokenScope } from "@furan/shared-types";

import type { AuthedUser } from "../plugins/auth.js";

import { emitAudit } from "./emit-audit.js";
import { isAtLeastAdmin } from "./roles.js";

/**
 * What an API token needs to use a REST route (ADR-064 step B), declared on
 * the route as `config: { tokenAccess }`:
 *
 * - `read`: a route that only reads; `sdk` and `read` tokens may use it.
 * - `sdk`: a route the SDK or CI writes through; only `sdk` tokens.
 *
 * A route that declares nothing is session-only for scoped tokens (403
 * `session_required`), so a new route is closed to them until it opts in.
 * `legacy` tokens ignore it: they keep the step-A gates (`requireSession`,
 * the admin-surface checks) until they expire.
 */
export type TokenAccess = "read" | "sdk";

declare module "fastify" {
  interface FastifyContextConfig {
    tokenAccess?: TokenAccess;
  }
}

/** A PAT caller, with the token's grant. */
export type PatAuth = Extract<AuthedUser, { via: "pat" }>;

/**
 * True for an API token minted with scopes (`sdk` / `read`), false for a
 * session and for a `legacy` token. Scoped tokens are the ones the step-B
 * rules apply to: route opt-in, project binding, no admin membership bypass,
 * no tRPC.
 */
export function isScopedToken(auth: AuthedUser): auth is PatAuth {
  return auth.via === "pat" && !auth.scopes.includes("legacy");
}

export type TokenRouteDenial = "session_required" | "insufficient_scope";

/**
 * Why a scoped token may not use a route that asks for `need`, or null when
 * it may. `sdk` covers `read`; nothing covers an undeclared route.
 */
export function tokenRouteDenial(
  scopes: readonly TokenScope[],
  need: TokenAccess | undefined,
): TokenRouteDenial | null {
  if (scopes.includes("legacy")) return null;
  if (need === undefined) return "session_required";
  if (scopes.includes("sdk")) return null;
  if (need === "read" && scopes.includes("read")) return null;
  return "insufficient_scope";
}

/**
 * True when the caller skips the project-membership check on `projectId`:
 * an admin or owner on a session or a `legacy` token (every project), or on a
 * token bound to exactly this project. An unbound scoped token never does —
 * it works on the projects its owner is a member of (ADR-064 step B).
 */
export function bypassesMembership(
  auth: AuthedUser,
  projectId: string,
): boolean {
  if (!isAtLeastAdmin(auth.role)) return false;
  if (!isScopedToken(auth)) return true;
  return auth.projectId === projectId;
}

/** True when `auth` is a token bound to a project other than `projectId`. */
export function boundElsewhere(auth: AuthedUser, projectId: string): boolean {
  return (
    isScopedToken(auth) &&
    auth.projectId !== null &&
    auth.projectId !== projectId
  );
}

export type TokenDenialReason =
  "expired" | "session_required" | "insufficient_scope" | "project";

/** One audit row per token and reason per window, per api process. */
const DENIAL_AUDIT_WINDOW_MS = 60 * 60 * 1000;
const DENIAL_AUDIT_MAX_KEYS = 10_000;
const lastDenialAudit = new Map<string, number>();

/**
 * Audit a refused use of an API token (`token.denied`): an expired token, a
 * scoped token on a route or project it doesn't cover. A leaked token shows up
 * here. Throttled to one row per token and reason per hour (per process), so a
 * misconfigured CI job retrying in a loop can't flood the log; metrics and the
 * request log still see every refusal. Best-effort, like every audit write.
 */
export async function auditTokenDenied(
  db: DB,
  event: {
    userId: string;
    tokenId: string;
    reason: TokenDenialReason;
    method: string;
    route: string;
  },
  logger: { error: (obj: object, msg: string) => void },
  now: number = Date.now(),
): Promise<void> {
  const key = `${event.tokenId}:${event.reason}`;
  const last = lastDenialAudit.get(key);
  if (last !== undefined && now - last < DENIAL_AUDIT_WINDOW_MS) return;
  if (lastDenialAudit.size >= DENIAL_AUDIT_MAX_KEYS) lastDenialAudit.clear();
  lastDenialAudit.set(key, now);
  await emitAudit(
    db,
    {
      actorId: event.userId,
      action: "token.denied",
      targetType: "token",
      targetId: event.tokenId,
      metadata: {
        reason: event.reason,
        method: event.method,
        route: event.route,
      },
    },
    logger,
  );
}

/** Test seam: forget the denial-audit throttle. */
export function resetTokenDenialAudit(): void {
  lastDenialAudit.clear();
}
