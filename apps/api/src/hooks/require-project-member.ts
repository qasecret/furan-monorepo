import {
  and,
  type DB,
  eq,
  projectMembers,
  withPrivilegedScope,
} from "@furan/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { sendError } from "../lib/errors.js";
import { isAtLeastAdmin } from "../lib/roles.js";
import {
  auditTokenDenied,
  boundElsewhere,
  bypassesMembership,
  isScopedToken,
} from "../lib/token-access.js";

export type Action = "read" | "write";

export type ScopeSource =
  | { params: string }
  | { body: string }
  // Resolvers receive a PRIVILEGED (RLS-bypass) db handle: they resolve a
  // project id from a project-scoped row (ADR-058), and the gate is the
  // authorization boundary, so it can't be subject to the RLS it enforces.
  | { resolver: (req: FastifyRequest, db: DB) => Promise<string | null> };

export interface ScopeOpts {
  from: ScopeSource;
}

interface Denial {
  code: 400 | 403;
  message: string;
  /** A scoped token bound to another project (audited as `token.denied`). */
  boundElsewhere?: true;
}

export function requireProjectMember(action: Action, opts: ScopeOpts) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth) {
      return sendError(reply, 401, "unauthenticated");
    }
    // admin/owner bypass per arch-backend.md §4.3, on a session or a `legacy`
    // token (role-only, not `hasAdminSurface`, so an admin's SDK token keeps
    // uploading to projects the admin manages but isn't a member of — ADR-064
    // step A). A scoped token is checked per project below: bound → only its
    // project (an admin skips membership there); unbound → member projects
    // only, no bypass (step B).
    const scoped = isScopedToken(req.auth);
    if (!scoped && isAtLeastAdmin(req.auth.role)) return;
    if (req.auth.role === "guest") {
      return sendError(reply, 403, "forbidden", undefined, { reason: "guest" });
    }
    const auth = req.auth;

    // The projectId lookup + the membership check are the authorization
    // boundary — run them PRIVILEGED (RLS bypass) so RLS can't hide the row the
    // gate needs to see. `withPrivilegedScope` opens its own transaction on the
    // pool (the handler's own scope, if any, runs separately afterwards), so
    // the owner GUC never leaks into business queries.
    const denial = await withPrivilegedScope(
      req.server.db,
      async (db): Promise<Denial | null> => {
        const projectId = await resolveProjectId(req, opts.from, db);
        if (!projectId) {
          return { code: 400, message: "missing_project_scope" };
        }
        if (boundElsewhere(auth, projectId)) {
          req.log.info(
            { action, projectId, userId: auth.id },
            "rbac_denied_token_project",
          );
          return {
            code: 403,
            message: "token_project_mismatch",
            boundElsewhere: true,
          };
        }
        if (bypassesMembership(auth, projectId)) return null;
        const rows = await db
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.userId, auth.id),
              eq(projectMembers.projectId, projectId),
            ),
          )
          .limit(1);
        if (rows.length === 0) {
          req.log.info(
            { action, projectId, userId: auth.id },
            "rbac_denied_not_member",
          );
          return { code: 403, message: "not_a_project_member" };
        }
        return null;
      },
    );

    if (denial) {
      if (denial.boundElsewhere && auth.via === "pat") {
        await auditTokenDenied(
          req.server.db,
          {
            userId: auth.id,
            tokenId: auth.tokenId,
            reason: "project",
            method: req.method,
            route: req.routeOptions.url ?? req.url,
          },
          req.log,
        );
        return sendError(
          reply,
          403,
          denial.message,
          "This API token is bound to a different project",
        );
      }
      return sendError(reply, denial.code, denial.message);
    }
  };
}

async function resolveProjectId(
  req: FastifyRequest,
  src: ScopeSource,
  db: DB,
): Promise<string | null> {
  if ("params" in src) {
    const value = (req.params as Record<string, unknown> | null | undefined)?.[
      src.params
    ];
    return typeof value === "string" ? value : null;
  }
  if ("body" in src) {
    const value = (req.body as Record<string, unknown> | null | undefined)?.[
      src.body
    ];
    return typeof value === "string" ? value : null;
  }
  return src.resolver(req, db);
}
