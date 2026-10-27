import { gateProjectMember, type GateProject, type SQL } from "@furan/db";
import { TRPCError } from "@trpc/server";

import type { GateLookup, Gated } from "../../lib/review/actions.js";
import { isAtLeastAdmin } from "../../lib/roles.js";
import type { Context } from "../context.js";
import { t } from "../trpc.js";

export type Action = "read" | "write";

export interface ProjectMemberOpts<TInput> {
  from:
    | {
        /**
         * The project of a run, a build or a review action (`runLookup`,
         * `buildLookup`, `actionLookup`), run like `query`. The gate also
         * hands its handler what it resolved, tied to that resource
         * (`ctx.gated`), so `require{Run,Build,Action}Project` on the same
         * resource read nothing.
         */
        lookup: (args: { input: TInput }) => GateLookup;
      }
    | {
        /**
         * The project, from a select the gate runs inside its own statement
         * (one column, at most one row; none when the resource does not
         * exist). Use it for a lookup of the resource's row: the gate then
         * costs 2 statements, the lookup included.
         */
        query: (args: { input: TInput }) => SQL;
      }
    | {
        /**
         * The project, resolved in code. Reads made through `ctx.db` run as
         * the RLS-bypass role, each its own statement on top of the gate's 2:
         * prefer `query` for a row lookup.
         */
        resolver: (args: {
          input: TInput;
          ctx: Context;
        }) => Promise<string | null>;
      };
}

/** What the gate adds to the context (see {@link projectMember}). */
export interface GatedContext {
  gated: Gated | null;
}

const gatedContext = (gated: Gated | null): GatedContext => ({ gated });

/**
 * tRPC analogue of `requireProjectMember` (hooks/require-project-member.ts).
 * Admin bypass; otherwise looks up `(userId, projectId)` in `project_members`.
 * Guests are rejected (parity with the REST hook).
 *
 * Downstream, behind a `lookup`, `ctx.gated` is the project the gate
 * resolved and checked the caller's membership in, with the resource it is
 * the project of (`{ kind, id, projectId }`), so a handler acting on that
 * same resource need not read it again; `require{Run,Build,Action}Project`
 * trust it only when kind and id are theirs, and otherwise read the project
 * themselves. It is null behind a `query` or a `resolver`, and for an admin,
 * who skips the gate: the handler then resolves the project itself (with the
 * same lookup, e.g. `requireRunProject`).
 */
export function projectMember<TInput>(
  _action: Action,
  opts: ProjectMemberOpts<TInput>,
) {
  return t.middleware(async ({ ctx, input, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
    // Role-only on purpose (not `hasAdminSurface`): the membership bypass also
    // applies to an admin's API token (ADR-064 step A; see the REST hook).
    if (isAtLeastAdmin(ctx.user.role)) {
      return next({ ctx: gatedContext(null) });
    }
    if (ctx.user.role === "guest") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    // The projectId lookup + membership check are the authorization boundary —
    // they must read rows RLS would hide, so `gateProjectMember` runs them with
    // the role ELEVATED to owner (RLS bypass) IN PLACE on the procedure's own
    // scoped transaction (ctx.db). Elevating in place — rather than a second
    // privileged connection — avoids each gated request holding two pooled
    // connections at once (ADR-058). The elevation is restored before the
    // procedure body runs, so resolvers reading `ctx.db` here are privileged;
    // business queries are not.
    const from = opts.from;
    const args = { input: input as TInput, ctx };
    let lookup: GateLookup | null = null;
    let project: GateProject;
    if ("lookup" in from) {
      lookup = from.lookup(args);
      project = { query: lookup.query };
    } else if ("query" in from) {
      project = { query: from.query(args) };
    } else {
      project = { resolve: () => from.resolver(args) };
    }
    const gate = await gateProjectMember(ctx.db, ctx.user.id, project);

    if (gate.outcome === "not_found") {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    if (gate.outcome === "forbidden") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    return next({
      ctx: gatedContext(
        lookup !== null
          ? { kind: lookup.kind, id: lookup.id, projectId: gate.projectId }
          : null,
      ),
    });
  });
}
