import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  auditLog,
  autoRules,
  checkpointDecisions,
  eq,
  inArray,
  or,
  projectMembers,
  sql,
  testRuns,
  users,
  type DB,
} from "@furan/db";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import type { Broadcaster } from "../src/lib/broadcast.js";
import {
  actionProjectQuery,
  resolveRunProject,
  runProjectQuery,
} from "../src/lib/review/actions.js";
import { buildContext, type Context } from "../src/trpc/context.js";
import { authed } from "../src/trpc/middlewares/authed.js";
import { projectMember } from "../src/trpc/middlewares/project-member.js";
import { publicProcedure, t } from "../src/trpc/trpc.js";
import { buildsRouter } from "../src/trpc/v1/builds.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import {
  bodyStatements,
  capturing,
  type CapturedStatement,
} from "./capturing-db.js";
import { createTestApp, type TestApp } from "./helpers.js";
import {
  cleanupReviewSeeds,
  cp,
  decideDirectly,
  seedReviewRun,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * The tRPC project-member gate (`projectMember`, spec 2026-10-27 §7): who it
 * lets through, what it refuses with, the scope a procedure body sees after
 * it, and how many statements it costs. The tables were captured from the
 * gate before it was folded into fewer statements, and pin that its outcomes
 * did not change: admin bypass, guests refused, a membership row required,
 * NOT_FOUND only for a resource that does not exist (a non-member still tells
 * "exists elsewhere" from "missing" exactly as before, no more and no less).
 * The suite runs as the API's own role, so with TEST_RLS=1 it runs under RLS.
 */

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

/** The scope settings, as the first statement of a procedure body reads them. */
interface Scope {
  user_id: string | null;
  user_role: string | null;
  project_id: string | null;
}

/** Marks the body's first statement in the wire log. */
const BODY_MARK = "gate-probe:body";

async function scopeSeenByBody(db: DB): Promise<Scope> {
  const rows = await db.execute<Scope>(sql`
    SELECT /* gate-probe:body */
      current_setting('app.user_id', true) AS user_id,
      current_setting('app.user_role', true) AS user_role,
      current_setting('app.current_project_id', true) AS project_id`);
  return rows[0]!;
}

const projectInput = z.object({ projectId: z.string().uuid() });
const runInput = z.object({ runId: z.string().uuid() });
const actionInput = z.object({ actionId: z.string().uuid() });

/**
 * Probe procedures: the production `publicProcedure` + `authed` +
 * `projectMember`, with the project sources production call sites use (a
 * row's lookup as the gate's `query`; the input's own `projectId` as a
 * `resolver`), and a body that reports the scope it runs in. The `ViaResolver`
 * ones resolve a run in code instead, the gate's other path. The
 * `OnlyWhenElevated` ones see the run's project only while the gate holds the
 * RLS-bypass role, so they let a member through only if the lookup runs
 * elevated.
 */
const probeRouter = t.router({
  project: publicProcedure
    .input(projectInput)
    .use(authed)
    .use(
      projectMember<{ projectId: string }>("read", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .query(({ ctx }) => scopeSeenByBody(ctx.db)),
  projectWrite: publicProcedure
    .input(projectInput)
    .use(authed)
    .use(
      projectMember<{ projectId: string }>("write", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .mutation(({ ctx }) => scopeSeenByBody(ctx.db)),
  run: publicProcedure
    .input(runInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("read", {
        from: { query: ({ input }) => runProjectQuery(input.runId) },
      }),
    )
    .query(({ ctx }) => scopeSeenByBody(ctx.db)),
  runWrite: publicProcedure
    .input(runInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: { query: ({ input }) => runProjectQuery(input.runId) },
      }),
    )
    .mutation(({ ctx }) => scopeSeenByBody(ctx.db)),
  runOnlyWhenElevated: publicProcedure
    .input(runInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("read", {
        from: {
          query: ({ input }) =>
            sql`SELECT ${testRuns.projectId} FROM ${testRuns}
              WHERE ${testRuns.id} = ${input.runId}
                AND current_setting('app.user_role', true) = 'owner'`,
        },
      }),
    )
    .query(({ ctx }) => scopeSeenByBody(ctx.db)),
  runViaResolver: publicProcedure
    .input(runInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("read", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProject(ctx.db, input.runId),
        },
      }),
    )
    .query(({ ctx }) => scopeSeenByBody(ctx.db)),
  runOnlyWhenElevatedViaResolver: publicProcedure
    .input(runInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("read", {
        from: {
          resolver: async ({ input, ctx }) => {
            const [row] = await ctx.db.execute<{ role: string | null }>(
              sql`SELECT current_setting('app.user_role', true) AS role`,
            );
            return row?.role === "owner"
              ? resolveRunProject(ctx.db, input.runId)
              : null;
          },
        },
      }),
    )
    .query(({ ctx }) => scopeSeenByBody(ctx.db)),
  action: publicProcedure
    .input(actionInput)
    .use(authed)
    .use(
      projectMember<{ actionId: string }>("write", {
        from: { query: ({ input }) => actionProjectQuery(input.actionId) },
      }),
    )
    .mutation(({ ctx }) => scopeSeenByBody(ctx.db)),
});

type CallerName =
  | "owner"
  | "adminOfNone"
  | "adminOfQ"
  | "editorOfP"
  | "guestOfP"
  | "editorOfQ"
  | "outsider"
  | "inactiveOfP"
  | "anonymous";

interface Caller {
  id: string;
  role: string;
  jwt: string | null;
}

const OK = "ok";
const UNAUTHORIZED = "UNAUTHORIZED 401 UNAUTHORIZED";
const FORBIDDEN = "FORBIDDEN 403 FORBIDDEN";
const NOT_FOUND = "NOT_FOUND 404 NOT_FOUND";
/** The gate let the call through: the cell is what the body answers. */
const BODY = "body";

type Row = readonly [inP: string, inQ: string, missing: string];

/**
 * A gate whose resolver reads the resource's row (run, build, variation,
 * rule, action): NOT_FOUND only when the row does not exist anywhere.
 */
const ROW_TABLE: Record<CallerName, Row> = {
  owner: [OK, OK, BODY],
  adminOfNone: [OK, OK, BODY],
  adminOfQ: [OK, OK, BODY],
  editorOfP: [OK, FORBIDDEN, NOT_FOUND],
  guestOfP: [FORBIDDEN, FORBIDDEN, FORBIDDEN],
  editorOfQ: [FORBIDDEN, OK, NOT_FOUND],
  outsider: [FORBIDDEN, FORBIDDEN, NOT_FOUND],
  inactiveOfP: [UNAUTHORIZED, UNAUTHORIZED, UNAUTHORIZED],
  anonymous: [UNAUTHORIZED, UNAUTHORIZED, UNAUTHORIZED],
};

/** A gate on the input's own `projectId`: a missing project is FORBIDDEN. */
const PROJECT_TABLE: Record<CallerName, Row> = {
  ...ROW_TABLE,
  editorOfP: [OK, FORBIDDEN, FORBIDDEN],
  editorOfQ: [FORBIDDEN, OK, FORBIDDEN],
  outsider: [FORBIDDEN, FORBIDDEN, FORBIDDEN],
};

const CALLER_NAMES = Object.keys(ROW_TABLE) as CallerName[];

/** `table` with each BODY cell replaced by what that procedure's body answers. */
function expectedTable(
  table: Record<CallerName, Row>,
  bodyOnMissing: string,
): Record<CallerName, Row> {
  return Object.fromEntries(
    CALLER_NAMES.map((name) => [
      name,
      table[name].map((cell) => (cell === BODY ? bodyOnMissing : cell)),
    ]),
  ) as Record<CallerName, Row>;
}

async function outcomeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return OK;
  } catch (err) {
    if (!(err instanceof TRPCClientError)) throw err;
    const data = err.data as { code?: string; httpStatus?: number } | null;
    return `${data?.code} ${data?.httpStatus} ${err.message}`;
  }
}

d("projectMember gate", () => {
  let h: TestApp;
  let baseUrl: string;
  let P: ReviewSeed;
  let Q: ReviewSeed;
  const callers = {} as Record<CallerName, Caller>;
  const extraUserIds: string[] = [];
  /** Resources: [in P, in Q, missing]. */
  let projectIds: [string, string, string];
  let runIds: [string, string, string];
  let buildIds: [string, string, string];
  let variationIds: [string, string, string];
  let ruleIds: [string, string, string];
  let actionIds: [string, string, string];

  /** Statements the API's own connection pool sent, while recording. */
  let wireLog: string[] | null = null;

  const headers = (c: Caller) =>
    c.jwt ? { authorization: `Bearer ${c.jwt}` } : {};
  const api = (c: Caller) =>
    createTRPCClient<AppRouter>({
      links: [httpLink({ url: `${baseUrl}/trpc`, headers: headers(c) })],
    });
  const probe = (c: Caller) =>
    createTRPCClient<typeof probeRouter>({
      links: [
        httpLink({ url: `${baseUrl}/trpc/gate-probe`, headers: headers(c) }),
      ],
    });

  async function addUser(
    role: "owner" | "admin" | "editor",
    opts: { memberOf?: string; isActive?: boolean } = {},
  ): Promise<Caller> {
    const [row] = await h.db
      .insert(users)
      .values({
        email: `gate-${role}-${randomUUID()}@gate.example`,
        hashedPassword: "x",
        firstName: "Gate",
        lastName: role,
        role,
        isActive: opts.isActive ?? true,
      })
      .returning({ id: users.id });
    const id = row!.id;
    extraUserIds.push(id);
    if (opts.memberOf) {
      await h.db
        .insert(projectMembers)
        .values({ userId: id, projectId: opts.memberOf });
    }
    return { id, role, jwt: h.app.jwt.sign({ sub: id, role }) };
  }

  async function addRule(seed: ReviewSeed): Promise<string> {
    const [rule] = await h.db
      .insert(autoRules)
      .values({
        projectId: seed.projectId,
        label: `gate-${seed.tag}`,
        match: {},
        action: "flag",
        createdBy: seed.editor.id,
        updatedBy: seed.editor.id,
      })
      .returning({ id: autoRules.id });
    return rule!.id;
  }

  async function addAction(seed: ReviewSeed): Promise<string> {
    const stepId = seed.shots.a!.id;
    await decideDirectly(h, seed, [stepId]);
    const [row] = await h.db
      .select({ actionId: checkpointDecisions.actionId })
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.screenshotId, stepId));
    return row!.actionId;
  }

  beforeAll(async () => {
    h = await createTestApp({ skipReady: true });
    await h.app.register(fastifyTRPCPlugin, {
      prefix: "/trpc/gate-probe",
      trpcOptions: {
        router: probeRouter,
        createContext: ({ req }) =>
          buildContext(req, {
            db: h.app.db,
            telemetry: h.telemetry,
            diffQueue: { addBulk: h.diffQueueAddBulk },
            broadcaster: {
              publishProjectEvent: h.broadcasterPublish,
            } as unknown as Broadcaster,
          }),
      } satisfies FastifyTRPCPluginOptions<typeof probeRouter>["trpcOptions"],
    });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;

    // Every statement the app's pool sends, read live by postgres.js.
    const client = (
      h.app.db as unknown as {
        $client: { options: { debug: unknown } };
      }
    ).$client;
    client.options.debug = (_conn: number, query: string) => {
      wireLog?.push(query);
    };

    P = await seedReviewRun(h, { checkpoints: [cp("a", "unresolved")] });
    Q = await seedReviewRun(h, { checkpoints: [cp("a", "unresolved")] });

    callers.owner = await addUser("owner");
    callers.adminOfNone = { ...P.admin, jwt: P.admin.jwt };
    callers.adminOfQ = await addUser("admin", { memberOf: Q.projectId });
    callers.editorOfP = { ...P.editor, jwt: P.editor.jwt };
    callers.guestOfP = { ...P.guest, jwt: P.guest.jwt };
    callers.editorOfQ = { ...Q.editor, jwt: Q.editor.jwt };
    callers.outsider = { ...P.outsider, jwt: P.outsider.jwt };
    callers.inactiveOfP = await addUser("editor", {
      memberOf: P.projectId,
      isActive: false,
    });
    callers.anonymous = { id: "", role: "", jwt: null };

    const missing = randomUUID();
    projectIds = [P.projectId, Q.projectId, missing];
    runIds = [P.runId, Q.runId, missing];
    buildIds = [P.buildId, Q.buildId, missing];
    variationIds = [P.shots.a!.variationId, Q.shots.a!.variationId, missing];
    ruleIds = [await addRule(P), await addRule(Q), missing];
    actionIds = [await addAction(P), await addAction(Q), missing];
  });

  afterAll(async () => {
    if (h) {
      await cleanupReviewSeeds(h, [P, Q].filter(Boolean));
      if (extraUserIds.length > 0) {
        await h.db
          .delete(auditLog)
          .where(
            or(
              inArray(auditLog.actorId, extraUserIds),
              inArray(auditLog.targetId, extraUserIds),
            ),
          );
        await h.db.delete(users).where(inArray(users.id, extraUserIds));
      }
      await h.close();
    }
  });

  /** Every caller × [in P, in Q, missing] through `call`. */
  async function observe(
    resources: readonly [string, string, string],
    call: (c: Caller, resource: string) => Promise<unknown>,
  ): Promise<Record<CallerName, Row>> {
    const table = {} as Record<CallerName, Row>;
    for (const name of CALLER_NAMES) {
      const row: string[] = [];
      for (const resource of resources) {
        row.push(await outcomeOf(() => call(callers[name], resource)));
      }
      table[name] = row as unknown as Row;
    }
    return table;
  }

  describe("behaviour table: the gate itself (probe procedures)", () => {
    test("on the input's projectId, read and write", async () => {
      const expected = expectedTable(PROJECT_TABLE, OK);
      expect(
        await observe(projectIds, (c, projectId) =>
          probe(c).project.query({ projectId }),
        ),
      ).toEqual(expected);
      expect(
        await observe(projectIds, (c, projectId) =>
          probe(c).projectWrite.mutate({ projectId }),
        ),
      ).toEqual(expected);
    });

    test("on a run's project (review.approve's resolver), read and write", async () => {
      const expected = expectedTable(ROW_TABLE, OK);
      expect(
        await observe(runIds, (c, runId) => probe(c).run.query({ runId })),
      ).toEqual(expected);
      expect(
        await observe(runIds, (c, runId) =>
          probe(c).runWrite.mutate({ runId }),
        ),
      ).toEqual(expected);
    });

    test("the lookup runs as the RLS-bypass role", async () => {
      expect(
        await observe(runIds, (c, runId) =>
          probe(c).runOnlyWhenElevated.query({ runId }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, OK));
    });

    test("a run resolved in code: the same table, its reads elevated", async () => {
      const expected = expectedTable(ROW_TABLE, OK);
      expect(
        await observe(runIds, (c, runId) =>
          probe(c).runViaResolver.query({ runId }),
        ),
      ).toEqual(expected);
      expect(
        await observe(runIds, (c, runId) =>
          probe(c).runOnlyWhenElevatedViaResolver.query({ runId }),
        ),
      ).toEqual(expected);
    });

    test("on a review action's project (review.revert's resolver)", async () => {
      expect(
        await observe(actionIds, (c, actionId) =>
          probe(c).action.mutate({ actionId }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, OK));
    });
  });

  describe("behaviour table: production procedures, one per resolver kind", () => {
    test("builds.pendingCount (the input's projectId)", async () => {
      expect(
        await observe(projectIds, (c, projectId) =>
          api(c).builds.pendingCount.query({ projectId }),
        ),
      ).toEqual(expectedTable(PROJECT_TABLE, OK));
    });

    test("runs.getById (a run, read)", async () => {
      expect(
        await observe(runIds, (c, runId) =>
          api(c).runs.getById.query({ runId }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, NOT_FOUND));
    });

    test("runs.listCheckpoints (a run, read)", async () => {
      expect(
        await observe(runIds, (c, runId) =>
          api(c).runs.listCheckpoints.query({ runId }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, OK));
    });

    test("runs.setComment (a run, write)", async () => {
      expect(
        await observe(runIds, (c, runId) =>
          api(c).runs.setComment.mutate({ runId, comment: "gate" }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, NOT_FOUND));
    });

    test("builds.getById (a build, read)", async () => {
      expect(
        await observe(buildIds, (c, buildId) =>
          api(c).builds.getById.query({ buildId }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, NOT_FOUND));
    });

    test("review.previewApproveBuild (a build, read)", async () => {
      expect(
        await observe(buildIds, (c, buildId) =>
          api(c).review.previewApproveBuild.query({ buildId }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, "NOT_FOUND 404 build_not_found"));
    });

    test("baselines.listForVariation (a variation, read)", async () => {
      expect(
        await observe(variationIds, (c, testVariationId) =>
          api(c).baselines.listForVariation.query({ testVariationId }),
        ),
      ).toEqual(expectedTable(ROW_TABLE, OK));
    });

    test("autoRules.get (a rule, read)", async () => {
      expect(
        await observe(ruleIds, (c, id) => api(c).autoRules.get.query({ id })),
      ).toEqual(expectedTable(ROW_TABLE, NOT_FOUND));
    });
  });

  describe("the scope a procedure body runs in", () => {
    const passing: CallerName[] = [
      "owner",
      "adminOfNone",
      "adminOfQ",
      "editorOfP",
    ];

    test("inside the body: the caller's own id and role, no project marker", async () => {
      for (const name of passing) {
        const c = callers[name];
        const want: Scope = {
          user_id: c.id,
          user_role: c.role,
          project_id: "",
        };
        expect(
          await probe(c).project.query({ projectId: P.projectId }),
        ).toEqual(want);
        expect(await probe(c).run.query({ runId: P.runId })).toEqual(want);
        expect(await probe(c).runViaResolver.query({ runId: P.runId })).toEqual(
          want,
        );
        expect(
          await probe(c).action.mutate({ actionId: actionIds[0] }),
        ).toEqual(want);
      }
    });

    test("after the call: no pooled connection keeps a scope setting", async () => {
      await probe(callers.editorOfP).run.query({ runId: P.runId });
      await outcomeOf(() =>
        probe(callers.outsider).run.query({ runId: P.runId }),
      );
      await outcomeOf(() =>
        probe(callers.editorOfP).run.query({ runId: randomUUID() }),
      );
      // Concurrent and slow, so they spread over the pool's connections.
      const seen = await Promise.all(
        Array.from({ length: 10 }, () =>
          h.app.db.execute<Scope>(sql`
            SELECT current_setting('app.user_id', true) AS user_id,
                   current_setting('app.user_role', true) AS user_role,
                   current_setting('app.current_project_id', true) AS project_id,
                   pg_sleep(0.05)::text AS slept`),
        ),
      );
      // A setting a committed transaction set locally reads back empty; one
      // never set on that connection reads back NULL.
      const unset = (v: string | null) => (v === null ? "" : v);
      for (const rows of seen) {
        const { user_id, user_role, project_id } = rows[0]!;
        expect([unset(user_id), unset(user_role), unset(project_id)]).toEqual([
          "",
          "",
          "",
        ]);
      }
    });
  });

  describe("statements", () => {
    /** The statements `call` sent on the wire, in order. */
    async function wireOf(call: () => Promise<unknown>): Promise<string[]> {
      const log: string[] = [];
      wireLog = log;
      try {
        await call();
      } finally {
        wireLog = null;
      }
      return log;
    }

    /** Statements between the request scope's own and the body's first. */
    function gateStatements(log: readonly string[]): number {
      const scopeAt = log.findIndex((q) =>
        q.includes("set_config('app.user_id'"),
      );
      const bodyAt = log.findIndex((q) => q.includes(BODY_MARK));
      expect(scopeAt).toBeGreaterThanOrEqual(0);
      expect(bodyAt).toBeGreaterThan(scopeAt);
      return bodyAt - scopeAt - 1;
    }

    test("the gate issues at most 2 statements before the body", async () => {
      const member = callers.editorOfP;
      const counts = {
        project: gateStatements(
          await wireOf(() =>
            probe(member).project.query({ projectId: P.projectId }),
          ),
        ),
        run: gateStatements(
          await wireOf(() => probe(member).run.query({ runId: P.runId })),
        ),
        action: gateStatements(
          await wireOf(() =>
            probe(member).action.mutate({ actionId: actionIds[0] }),
          ),
        ),
      };
      for (const n of Object.values(counts)) expect(n).toBeGreaterThan(0);
      const over = Object.entries(counts).filter(([, n]) => n > 2);
      expect({ counts, over }).toEqual({ counts, over: [] });
    });

    test("a resolver's own reads come on top of the gate's 2", async () => {
      const log = await wireOf(() =>
        probe(callers.editorOfP).runViaResolver.query({ runId: P.runId }),
      );
      expect(gateStatements(log)).toBe(3);
    });

    test("production procedures: a member's call costs at most 2 statements more than an admin's", async () => {
      /** Statements from the request scope's own to the end of the call. */
      const inScope = (log: readonly string[]) => {
        const scopeAt = log.findIndex((q) =>
          q.includes("set_config('app.user_id'"),
        );
        expect(scopeAt).toBeGreaterThanOrEqual(0);
        return log.length - scopeAt;
      };
      const calls: Record<string, (c: Caller) => Promise<unknown>> = {
        "builds.pendingCount": (c) =>
          api(c).builds.pendingCount.query({ projectId: P.projectId }),
        "runs.getById": (c) => api(c).runs.getById.query({ runId: P.runId }),
        "runs.listCheckpoints": (c) =>
          api(c).runs.listCheckpoints.query({ runId: P.runId }),
        "builds.getById": (c) =>
          api(c).builds.getById.query({ buildId: P.buildId }),
        "review.previewApproveBuild": (c) =>
          api(c).review.previewApproveBuild.query({ buildId: P.buildId }),
        "baselines.listForVariation": (c) =>
          api(c).baselines.listForVariation.query({
            testVariationId: variationIds[0],
          }),
        "autoRules.get": (c) => api(c).autoRules.get.query({ id: ruleIds[0] }),
      };
      const extra: Record<string, number> = {};
      for (const [name, call] of Object.entries(calls)) {
        const member = inScope(await wireOf(() => call(callers.editorOfP)));
        const admin = inScope(await wireOf(() => call(callers.adminOfNone)));
        extra[name] = member - admin;
      }
      expect(extra).toEqual({
        ...Object.fromEntries(Object.keys(calls).map((name) => [name, 2])),
        // Its handler acts in the project the gate resolved
        // (`ctx.gated`); an admin, who skips the gate, reads the
        // build's project instead. So a member pays 2 - 1.
        "review.previewApproveBuild": 1,
      });
    });

    test("the shared capturing proxy counts the gate's statements as the request's", async () => {
      const counted = async (c: Caller) => {
        const statements: CapturedStatement[] = [];
        await buildsRouter
          .createCaller({
            user: { id: c.id, role: c.role, via: "jwt" },
            db: capturing(h.app.db, statements),
          } as unknown as Context)
          .pendingCount({ projectId: P.projectId });
        return bodyStatements(statements).length;
      };
      const member = await counted(callers.editorOfP);
      const admin = await counted(callers.adminOfNone);
      expect(admin).toBeGreaterThan(0);
      expect(member - admin).toBe(2);
    });

    test("an admin's call skips the gate: no statement before the body", async () => {
      const log = await wireOf(() =>
        probe(callers.adminOfNone).run.query({ runId: P.runId }),
      );
      expect(gateStatements(log)).toBe(0);
    });
  });
});
