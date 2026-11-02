import {
  and,
  desc,
  eq,
  projectMembers,
  projects,
  sql,
  tokens,
  withPrivilegedScope,
} from "@furan/db";
import {
  boundedArray,
  DEFAULT_TOKEN_LIFETIME_DAYS,
  mintableTokenScopeSchema,
  TOKEN_LIFETIME_DAYS,
  tokenScopeSchema,
  type MintableTokenScope,
} from "@furan/shared-types";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireSession } from "../hooks/require-session.js";
import { emitAudit } from "../lib/emit-audit.js";
import { sendError } from "../lib/errors.js";
import { isAtLeastAdmin } from "../lib/roles.js";
import { generateRawToken } from "../lib/token.js";
import type { AuthedUser } from "../plugins/auth.js";

/** The longest lifetime a request may ask for when the operator lifts the cap. */
const MAX_REQUESTABLE_DAYS = 3650;

export const createBody = z.object({
  label: z.string().min(1).max(80),
  scopes: boundedArray(mintableTokenScopeSchema, 2, { min: 1 })
    .optional()
    .describe(
      "What the token may do: `sdk` (the default: SDK and CI uploads, plus reads) or `read` (reads only).",
    ),
  projectId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe(
      "Bind the token to this project. Omitted or null: every project you're a member of.",
    ),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(MAX_REQUESTABLE_DAYS)
    .nullable()
    .optional()
    .describe(
      "Lifetime in days. Omitted: 90 (or the operator's cap, if lower). null: never expires, allowed only when the operator sets FURAN_PAT_MAX_LIFETIME_DAYS=0.",
    ),
});

export const paramsId = z.object({ id: z.string().uuid() });

export const tokenSummary = z.object({
  id: z.string().uuid(),
  label: z.string(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  lastUsedIp: z.string().nullable(),
  scopes: z.array(tokenScopeSchema),
  projectId: z.string().uuid().nullable(),
  projectName: z
    .string()
    .nullable()
    .describe("The bound project's name; null when unbound."),
  expiresAt: z.date().nullable(),
});
export const tokenListResponse = z.array(tokenSummary);
export const tokenCreateResponse = z.object({
  id: z.string().uuid(),
  label: z.string(),
  createdAt: z.date(),
  scopes: z.array(tokenScopeSchema),
  projectId: z.string().uuid().nullable(),
  expiresAt: z.date().nullable(),
  token: z
    .string()
    .describe("Raw `furan_pat_*` token — shown ONCE, never retrievable again."),
});
export const tokenPolicyResponse = z.object({
  lifetimeDays: z
    .array(z.number().int())
    .describe("The lifetimes a new token may have, in days."),
  defaultLifetimeDays: z.number().int(),
  allowNoExpiry: z
    .boolean()
    .describe(
      "True when the operator lifted the cap: a token may never expire.",
    ),
});

/**
 * What the operator allows (FURAN_PAT_MAX_LIFETIME_DAYS, `cap`): the
 * dashboard's lifetimes up to the cap (and the cap itself when it isn't one of
 * them), the default (90 days, or the cap if lower), and whether a token may
 * never expire (cap 0).
 */
export function tokenPolicy(cap: number): z.infer<typeof tokenPolicyResponse> {
  if (cap === 0) {
    return {
      lifetimeDays: [...TOKEN_LIFETIME_DAYS],
      defaultLifetimeDays: DEFAULT_TOKEN_LIFETIME_DAYS,
      allowNoExpiry: true,
    };
  }
  const offered: number[] = TOKEN_LIFETIME_DAYS.filter((d) => d <= cap);
  if (!offered.includes(cap)) offered.push(cap);
  return {
    lifetimeDays: offered,
    defaultLifetimeDays: Math.min(DEFAULT_TOKEN_LIFETIME_DAYS, cap),
    allowNoExpiry: false,
  };
}

/** `sdk` covers `read`, so a token stores one scope. */
function normalizeScopes(requested: MintableTokenScope[] | undefined) {
  return !requested || requested.includes("sdk") ? ["sdk"] : ["read"];
}

/**
 * True when `auth` may bind a token to `projectId`: the project exists and
 * the caller can use it — a member, or an admin/owner (who manages every
 * project). Guests can't use projects, so they can't bind. Privileged (RLS
 * bypass) because this is an authorization check, like the membership gates.
 */
async function canBindProject(
  app: FastifyInstance,
  auth: AuthedUser,
  projectId: string,
): Promise<boolean> {
  if (auth.role === "guest") return false;
  return withPrivilegedScope(app.db, async (db) => {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return false;
    if (isAtLeastAdmin(auth.role)) return true;
    const [member] = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, auth.id),
          eq(projectMembers.projectId, projectId),
        ),
      )
      .limit(1);
    return member !== undefined;
  });
}

export async function registerTokensRoutes(
  app: FastifyInstance,
): Promise<void> {
  const cap = app.env.FURAN_PAT_MAX_LIFETIME_DAYS;
  const policy = tokenPolicy(cap);

  // Token management is session-only (`requireSession`, ADR-064 step A): an
  // API token can't list, mint or revoke tokens, so a leaked CI token can't
  // re-mint itself or outlive its own revocation.
  app.get(
    "/account/tokens",
    { preHandler: [app.authenticate, requireSession] },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      const userId = req.auth.id;
      // Privileged so the bound project's name shows even under RLS (the
      // caller chose that project when minting the token).
      const rows = await withPrivilegedScope(app.db, (db) =>
        db
          .select({
            id: tokens.id,
            label: tokens.label,
            createdAt: tokens.createdAt,
            lastUsedAt: tokens.lastUsedAt,
            lastUsedIp: tokens.lastUsedIp,
            scopes: tokens.scopes,
            projectId: tokens.projectId,
            projectName: projects.name,
            expiresAt: tokens.expiresAt,
          })
          .from(tokens)
          .leftJoin(projects, eq(projects.id, tokens.projectId))
          .where(eq(tokens.userId, userId))
          .orderBy(desc(tokens.createdAt), desc(tokens.id)),
      );
      return rows;
    },
  );

  // What a new token may be: the lifetimes on offer (the operator's cap) and
  // the default, for the dashboard's create dialog.
  app.get(
    "/account/token-policy",
    { preHandler: [app.authenticate, requireSession] },
    async () => policy,
  );

  app.post(
    "/account/tokens",
    {
      preHandler: [app.authenticate, requireSession],
      // PAT minting is rare in normal use; cap the burst so a compromised
      // session can't mass-mint tokens. Opt-in per-route (same pattern as
      // /auth/login) since the rate-limit plugin is registered global:false.
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body");
      }
      const { label, projectId = null, expiresInDays } = parsed.data;
      const scopes = normalizeScopes(parsed.data.scopes);

      let days: number | null;
      if (expiresInDays === undefined) {
        days = policy.defaultLifetimeDays;
      } else if (expiresInDays === null) {
        if (!policy.allowNoExpiry) {
          return sendError(
            reply,
            400,
            "expiry_required",
            `Tokens must expire; pick at most ${cap} days`,
          );
        }
        days = null;
      } else {
        if (cap !== 0 && expiresInDays > cap) {
          return sendError(
            reply,
            400,
            "expiry_too_long",
            `Tokens may last at most ${cap} days`,
          );
        }
        days = expiresInDays;
      }

      if (
        projectId !== null &&
        !(await canBindProject(app, req.auth, projectId))
      ) {
        return sendError(reply, 404, "project_not_found");
      }

      const { raw, hash } = generateRawToken();
      const [row] = await app.db
        .insert(tokens)
        .values({
          userId: req.auth.id,
          label,
          hash,
          scopes,
          projectId,
          // DB clock, the same one the auth check compares against.
          expiresAt:
            days === null ? null : sql`now() + make_interval(days => ${days})`,
        })
        .returning({
          id: tokens.id,
          label: tokens.label,
          createdAt: tokens.createdAt,
          scopes: tokens.scopes,
          projectId: tokens.projectId,
          expiresAt: tokens.expiresAt,
        });
      // PATs are long-lived credentials for CI/SDK — mint/revoke belongs in the
      // audit trail (never the raw token or its hash, only id + grant).
      await emitAudit(
        app.db,
        {
          actorId: req.auth.id,
          action: "token.created",
          targetType: "token",
          targetId: row?.id ?? null,
          metadata: {
            label,
            scopes,
            projectId,
            expiresAt: row?.expiresAt?.toISOString() ?? null,
          },
        },
        req.log,
      );
      return reply.code(201).send({ ...row, token: raw });
    },
  );

  app.delete(
    "/account/tokens/:id",
    { preHandler: [app.authenticate, requireSession] },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      const parsed = paramsId.safeParse(req.params);
      if (!parsed.success) {
        return sendError(reply, 404, "not_found");
      }
      const result = await app.db
        .delete(tokens)
        .where(
          and(eq(tokens.id, parsed.data.id), eq(tokens.userId, req.auth.id)),
        )
        .returning({ id: tokens.id, label: tokens.label });
      if (result.length === 0) {
        return sendError(reply, 404, "not_found");
      }
      await emitAudit(
        app.db,
        {
          actorId: req.auth.id,
          action: "token.deleted",
          targetType: "token",
          targetId: parsed.data.id,
          metadata: { label: result[0]?.label ?? null },
        },
        req.log,
      );
      return reply.code(204).send();
    },
  );
}
