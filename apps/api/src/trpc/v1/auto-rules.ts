import {
  and,
  autoRuleApplications,
  autoRules,
  desc,
  eq,
  isNull,
  lt,
  sql,
  testRuns,
} from "@furan/db";
import { createAutoRuleInput, updateAutoRuleInput } from "@furan/shared-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

const projectIdInput = z.object({ projectId: z.string().uuid() });
type ProjectIdInput = z.infer<typeof projectIdInput>;

const fromProjectId = {
  from: {
    resolver: ({ input }: { input: ProjectIdInput; ctx: Context }) =>
      Promise.resolve(input.projectId),
  },
};

/**
 * Resolve the owning project of a rule referenced by `id` (get/update/
 * delete/toggle). Returns null for a missing OR soft-deleted rule so the
 * projectMember middleware surfaces NOT_FOUND — this is the authorization
 * gate that keeps rules project-scoped (CLAUDE.md: every project-scoped
 * procedure wires in projectMember).
 */
function projectIdFromRuleId<TInput extends { id: string }>() {
  return {
    from: {
      resolver: async ({ input, ctx }: { input: TInput; ctx: Context }) => {
        const rows = await ctx.db
          .select({ projectId: autoRules.projectId })
          .from(autoRules)
          .where(and(eq(autoRules.id, input.id), isNull(autoRules.deletedAt)))
          .limit(1);
        return rows[0]?.projectId ?? null;
      },
    },
  };
}

export const autoRulesRouter = t.router({
  list: publicProcedure
    .input(projectIdInput)
    .use(authed)
    .use(projectMember<ProjectIdInput>("read", fromProjectId))
    .query(async ({ input, ctx }) => {
      return ctx.db
        .select()
        .from(autoRules)
        .where(
          and(
            eq(autoRules.projectId, input.projectId),
            isNull(autoRules.deletedAt),
          ),
        )
        .orderBy(desc(autoRules.createdAt));
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .use(authed)
    .use(projectMember<{ id: string }>("read", projectIdFromRuleId()))
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select()
        .from(autoRules)
        .where(and(eq(autoRules.id, input.id), isNull(autoRules.deletedAt)))
        .limit(1);
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return rows[0];
    }),

  create: publicProcedure
    .input(createAutoRuleInput)
    .use(authed)
    .use(
      projectMember<z.infer<typeof createAutoRuleInput>>("write", {
        from: {
          resolver: ({ input }) => Promise.resolve(input.projectId),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const rows = await ctx.db
        .insert(autoRules)
        .values({
          projectId: input.projectId,
          label: input.label,
          match: input.match,
          conditions: input.conditions ?? null,
          action: input.action,
          createdBy: ctx.user!.id,
          updatedBy: ctx.user!.id,
        })
        .returning();
      return rows[0];
    }),

  update: publicProcedure
    .input(updateAutoRuleInput)
    .use(authed)
    .use(
      projectMember<z.infer<typeof updateAutoRuleInput>>(
        "write",
        projectIdFromRuleId(),
      ),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, version, ...fields } = input;
      const setFields: Record<string, unknown> = {
        updatedBy: ctx.user!.id,
        updatedAt: new Date(),
        version: sql`${autoRules.version} + 1`,
      };
      if (fields.label !== undefined) setFields.label = fields.label;
      if (fields.match !== undefined) setFields.match = fields.match;
      if (fields.conditions !== undefined)
        setFields.conditions = fields.conditions ?? null;
      if (fields.action !== undefined) setFields.action = fields.action;
      if (fields.enabled !== undefined) setFields.enabled = fields.enabled;

      const rows = await ctx.db
        .update(autoRules)
        .set(setFields)
        .where(
          and(
            eq(autoRules.id, id),
            eq(autoRules.version, version),
            isNull(autoRules.deletedAt),
          ),
        )
        .returning();

      if (rows.length === 0) {
        // No row matched either because the version moved on (lost update) or
        // the rule was deleted. Both are conflicts from the caller's view.
        throw new TRPCError({
          code: "CONFLICT",
          message: "RULE_VERSION_MISMATCH",
        });
      }
      return rows[0];
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .use(authed)
    .use(projectMember<{ id: string }>("write", projectIdFromRuleId()))
    .mutation(async ({ input, ctx }) => {
      const rows = await ctx.db
        .update(autoRules)
        .set({ deletedAt: new Date(), updatedBy: ctx.user!.id })
        .where(and(eq(autoRules.id, input.id), isNull(autoRules.deletedAt)))
        .returning({ id: autoRules.id });
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return { deleted: true };
    }),

  toggle: publicProcedure
    .input(z.object({ id: z.string().uuid(), enabled: z.boolean() }))
    .use(authed)
    .use(projectMember<{ id: string }>("write", projectIdFromRuleId()))
    .mutation(async ({ input, ctx }) => {
      const rows = await ctx.db
        .update(autoRules)
        .set({
          enabled: input.enabled,
          updatedBy: ctx.user!.id,
          updatedAt: new Date(),
          version: sql`${autoRules.version} + 1`,
        })
        .where(and(eq(autoRules.id, input.id), isNull(autoRules.deletedAt)))
        .returning();
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return rows[0];
    }),

  applications: publicProcedure
    .input(
      z.object({
        ruleId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
        // Keyset cursor: the `appliedAt` (ISO timestamp) of the last item from
        // the previous page. Ordering is desc(appliedAt), so the next page is
        // everything strictly older than the cursor.
        cursor: z.string().datetime().nullish(),
      }),
    )
    .use(authed)
    .use(
      projectMember<{ ruleId: string }>("read", {
        from: {
          resolver: async ({
            input,
            ctx,
          }: {
            input: { ruleId: string };
            ctx: Context;
          }) => {
            const rows = await ctx.db
              .select({ projectId: autoRules.projectId })
              .from(autoRules)
              .where(
                and(
                  eq(autoRules.id, input.ruleId),
                  isNull(autoRules.deletedAt),
                ),
              )
              .limit(1);
            return rows[0]?.projectId ?? null;
          },
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(autoRuleApplications.ruleId, input.ruleId)];
      if (input.cursor) {
        conditions.push(
          lt(autoRuleApplications.appliedAt, new Date(input.cursor)),
        );
      }
      const rows = await ctx.db
        .select({
          id: autoRuleApplications.id,
          ruleVersion: autoRuleApplications.ruleVersion,
          testRunId: autoRuleApplications.testRunId,
          regionDiffPct: autoRuleApplications.regionDiffPct,
          actionPriority: autoRuleApplications.actionPriority,
          won: autoRuleApplications.won,
          appliedAt: autoRuleApplications.appliedAt,
          runStatus: testRuns.status,
          runBranch: testRuns.branchName,
        })
        .from(autoRuleApplications)
        .innerJoin(testRuns, eq(autoRuleApplications.testRunId, testRuns.id))
        .where(and(...conditions))
        .orderBy(desc(autoRuleApplications.appliedAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? last.appliedAt.toISOString() : null,
      };
    }),
});
