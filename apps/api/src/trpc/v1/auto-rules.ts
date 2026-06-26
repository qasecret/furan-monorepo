import {
  and,
  autoRuleApplications,
  autoRules,
  desc,
  eq,
  isNull,
  sql,
  testRuns,
} from "@furan/db";
import { createAutoRuleInput, updateAutoRuleInput } from "@furan/shared-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const projectIdInput = z.object({ projectId: z.string().uuid() });
type ProjectIdInput = z.infer<typeof projectIdInput>;

const fromProjectId = {
  from: {
    resolver: ({ input }: { input: ProjectIdInput; ctx: Context }) =>
      Promise.resolve(input.projectId),
  },
};

export const autoRulesRouter = t.router({
  list: t.procedure
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

  get: t.procedure
    .input(z.object({ id: z.string().uuid() }))
    .use(authed)
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select()
        .from(autoRules)
        .where(eq(autoRules.id, input.id))
        .limit(1);
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return rows[0];
    }),

  create: t.procedure
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

  update: t.procedure
    .input(updateAutoRuleInput)
    .use(authed)
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
        .where(and(eq(autoRules.id, id), eq(autoRules.version, version)))
        .returning();

      if (rows.length === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "RULE_VERSION_MISMATCH",
        });
      }
      return rows[0];
    }),

  delete: t.procedure
    .input(z.object({ id: z.string().uuid() }))
    .use(authed)
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(autoRules)
        .set({ deletedAt: new Date(), updatedBy: ctx.user!.id })
        .where(eq(autoRules.id, input.id));
      return { deleted: true };
    }),

  toggle: t.procedure
    .input(z.object({ id: z.string().uuid(), enabled: z.boolean() }))
    .use(authed)
    .mutation(async ({ input, ctx }) => {
      const rows = await ctx.db
        .update(autoRules)
        .set({
          enabled: input.enabled,
          updatedBy: ctx.user!.id,
          updatedAt: new Date(),
          version: sql`${autoRules.version} + 1`,
        })
        .where(eq(autoRules.id, input.id))
        .returning();
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return rows[0];
    }),

  applications: t.procedure
    .input(
      z.object({
        ruleId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().uuid().nullish(),
      }),
    )
    .use(authed)
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select({
          id: autoRuleApplications.id,
          ruleVersion: autoRuleApplications.ruleVersion,
          testRunId: autoRuleApplications.testRunId,
          regionDiffPct: autoRuleApplications.regionDiffPct,
          severity: autoRuleApplications.severity,
          won: autoRuleApplications.won,
          appliedAt: autoRuleApplications.appliedAt,
          runStatus: testRuns.status,
          runBranch: testRuns.branchName,
        })
        .from(autoRuleApplications)
        .innerJoin(testRuns, eq(autoRuleApplications.testRunId, testRuns.id))
        .where(eq(autoRuleApplications.ruleId, input.ruleId))
        .orderBy(desc(autoRuleApplications.appliedAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]!.id : null,
      };
    }),
});
