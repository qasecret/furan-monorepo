import { and, eq, projectMembers } from "@furan/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { sendError } from "../lib/errors.js";
import { isAtLeastAdmin } from "../lib/roles.js";

export type Action = "read" | "write";

export type ScopeSource =
  | { params: string }
  | { body: string }
  | { resolver: (req: FastifyRequest) => Promise<string | null> };

export interface ScopeOpts {
  from: ScopeSource;
}

export function requireProjectMember(action: Action, opts: ScopeOpts) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth) {
      return sendError(reply, 401, "unauthenticated");
    }
    if (isAtLeastAdmin(req.auth.role)) return; // admin/owner bypass per arch-backend.md §4.3
    if (req.auth.role === "guest") {
      return sendError(reply, 403, "forbidden", undefined, { reason: "guest" });
    }

    const projectId = await resolveProjectId(req, opts.from);
    if (!projectId) {
      return sendError(reply, 400, "missing_project_scope");
    }

    const rows = await req.server.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, req.auth.id),
          eq(projectMembers.projectId, projectId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      req.log.info(
        { action, projectId, userId: req.auth.id },
        "rbac_denied_not_member",
      );
      return sendError(reply, 403, "not_a_project_member");
    }
  };
}

async function resolveProjectId(
  req: FastifyRequest,
  src: ScopeSource,
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
  return src.resolver(req);
}
