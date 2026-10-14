import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { eq, inArray, projects, users } from "@furan/db";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { TRPCError } from "@trpc/server";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { z } from "zod";

import type { Broadcaster } from "../src/lib/broadcast.js";
import { hashPassword } from "../src/lib/password.js";
import { buildContext } from "../src/trpc/context.js";
import { publicProcedure, t } from "../src/trpc/trpc.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

/**
 * `scopeToUser` runs every authenticated procedure in one transaction. tRPC's
 * `next()` reports a failing procedure as `{ ok: false }` instead of throwing,
 * so these probes pin the contract: a procedure that throws after writing
 * leaves nothing behind, its error reaches the caller untouched, and
 * `ctx.onCommit` effects fire only after a successful commit.
 */
d("tRPC request scope atomicity", () => {
  let h: TestApp;
  let baseUrl: string;
  let jwt: string;
  let userId: string;
  const createdNames: string[] = [];

  // What the probe procedures observed, reset per test.
  let effects: Array<{ name: string; visibleToOtherConnection: boolean }>;
  let serverErrors: TRPCError[];
  let thrown: TRPCError | undefined;
  const refusalCause = new Error("probe refusal detail");

  function uniqueName(): string {
    const name = `scope-probe-${randomUUID()}`;
    createdNames.push(name);
    return name;
  }

  async function projectRowsNamed(name: string): Promise<number> {
    const rows = await h.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, name));
    return rows.length;
  }

  // Registered on the real `t` + `publicProcedure`, so the probes run through
  // the production `scopeToUser` middleware.
  const probeRouter = t.router({
    writeThenThrow: publicProcedure
      .input(z.object({ name: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await ctx.db.insert(projects).values({ name: input.name });
        ctx.onCommit(() => {
          effects.push({ name: input.name, visibleToOtherConnection: false });
        });
        thrown = new TRPCError({
          code: "CONFLICT",
          message: "probe_refused",
          cause: refusalCause,
        });
        throw thrown;
      }),
    writeThenSucceed: publicProcedure
      .input(z.object({ name: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await ctx.db.insert(projects).values({ name: input.name });
        ctx.onCommit(async () => {
          // `h.db` is a separate (owner) connection: it sees the row only once
          // the request transaction has committed.
          effects.push({
            name: input.name,
            visibleToOtherConnection:
              (await projectRowsNamed(input.name)) === 1,
          });
        });
        return { name: input.name };
      }),
  });

  function makeClient() {
    return createTRPCClient<typeof probeRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}/trpc/probe`,
          headers: { authorization: `Bearer ${jwt}` },
        }),
      ],
    });
  }

  beforeAll(async () => {
    h = await createTestApp({ skipReady: true });
    // Under `/trpc/` so the app's real soft-authenticate hook resolves the
    // caller, exactly as for the production router.
    await h.app.register(fastifyTRPCPlugin, {
      prefix: "/trpc/probe",
      trpcOptions: {
        router: probeRouter,
        createContext: ({ req }) =>
          buildContext(req, {
            db: h.app.db,
            telemetry: h.telemetry,
            diffQueue: { add: h.diffQueueAdd },
            broadcaster: {
              publishProjectEvent: h.broadcasterPublish,
            } as unknown as Broadcaster,
          }),
        onError: ({ error }) => {
          serverErrors.push(error);
        },
      } satisfies FastifyTRPCPluginOptions<typeof probeRouter>["trpcOptions"],
    });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Admin, so the probe's `projects` insert also passes the RLS WITH CHECK
    // when the suite runs with TEST_RLS=1.
    const [user] = await h.db
      .insert(users)
      .values({
        email: `scope-probe-${randomUUID()}@t.example`,
        hashedPassword: await hashPassword("x"),
        firstName: "Scope",
        lastName: "Probe",
        role: "admin",
        isActive: true,
      })
      .returning();
    userId = user!.id;
    jwt = h.app.jwt.sign({ sub: userId, role: "admin" });
  });

  beforeEach(() => {
    effects = [];
    serverErrors = [];
    thrown = undefined;
  });

  afterAll(async () => {
    if (createdNames.length > 0) {
      await h.db.delete(projects).where(inArray(projects.name, createdNames));
    }
    if (userId) await h.db.delete(users).where(eq(users.id, userId));
    await h.close();
  });

  test("a procedure that throws after writing leaves no rows behind", async () => {
    const name = uniqueName();

    await expect(makeClient().writeThenThrow.mutate({ name })).rejects.toThrow(
      "probe_refused",
    );

    expect(await projectRowsNamed(name)).toBe(0);
  });

  test("the caller gets the procedure's own error, not a wrapper", async () => {
    const err = await makeClient()
      .writeThenThrow.mutate({ name: uniqueName() })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(TRPCClientError);
    const clientErr = err as TRPCClientError<typeof probeRouter>;
    expect(clientErr.data?.code).toBe("CONFLICT");
    expect(clientErr.data?.httpStatus).toBe(409);
    expect(clientErr.message).toBe("probe_refused");
    // Server side, tRPC formats the very error the procedure threw — `cause`
    // intact — so an errorFormatter that reads `error.cause` keeps working.
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]).toBe(thrown);
    expect(serverErrors[0]!.cause).toBe(refusalCause);
  });

  test("a successful procedure commits, then runs its onCommit effects", async () => {
    const name = uniqueName();

    await expect(
      makeClient().writeThenSucceed.mutate({ name }),
    ).resolves.toEqual({ name });

    expect(await projectRowsNamed(name)).toBe(1);
    expect(effects).toEqual([{ name, visibleToOtherConnection: true }]);
  });

  test("a failing procedure's onCommit effects never run", async () => {
    await expect(
      makeClient().writeThenThrow.mutate({ name: uniqueName() }),
    ).rejects.toThrow("probe_refused");

    expect(effects).toEqual([]);
  });
});
