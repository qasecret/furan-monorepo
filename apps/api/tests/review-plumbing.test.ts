import type { AddressInfo } from "node:net";

import { Registry } from "@furan/telemetry";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { TRPCError } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { reviewError } from "../src/lib/review/errors.js";
import {
  recordReviewDecisions,
  recordReviewRevert,
  recordReviewRevertRefused,
} from "../src/lib/review/metrics.js";
import type { Context } from "../src/trpc/context.js";
import { t } from "../src/trpc/trpc.js";

/**
 * Throwaway router built on the SAME `t` the production routers use, so the
 * `errorFormatter` registered on it is what shapes these errors. It is never
 * mounted on the production app. `createCaller` bypasses the formatter, so the
 * wire shape is proven over real HTTP (what the dashboard actually receives).
 */
const testRouter = t.router({
  refusal: t.procedure.query(() => {
    throw reviewError("CONFLICT", "x", {
      reasons: [{ checkpointId: "c", reason: "already_decided" }],
    });
  }),
  refusalWithWinner: t.procedure.query(() => {
    throw reviewError("CONFLICT", "lost the race", {
      winner: { checkpointId: "c", kind: "approved", actorName: "Ada" },
    });
  }),
  refusalNoDetails: t.procedure.query(() => {
    throw reviewError("FORBIDDEN", "nope");
  }),
  plainError: t.procedure.query(() => {
    throw new TRPCError({ code: "NOT_FOUND", message: "missing" });
  }),
  plainErrorWithCause: t.procedure.query(() => {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "bad",
      cause: new Error("boom"),
    });
  }),
});
type TestRouter = typeof testRouter;

function metricValues(
  json: Awaited<ReturnType<Registry["getMetricsAsJSON"]>>,
  name: string,
) {
  const metric = json.find((m) => m.name === name);
  return (metric?.values ?? []).map((v) => ({
    labels: v.labels,
    value: v.value,
  }));
}

describe("reviewError + errorFormatter", () => {
  let app: FastifyInstance;
  let client: ReturnType<typeof createTRPCClient<TestRouter>>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: {
        router: testRouter,
        // The throwaway procedures never touch the context.
        createContext: () => ({}) as Context,
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    client = createTRPCClient<TestRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${port}/trpc` })],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  test("a review refusal carries its structured details over the wire", async () => {
    const err = await client.refusal.query().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCClientError);
    const e = err as TRPCClientError<TestRouter>;
    expect(e.message).toBe("x");
    expect(e.data?.code).toBe("CONFLICT");
    expect(e.data?.details?.reasons?.[0]?.reason).toBe("already_decided");
    expect(e.data?.details?.reasons?.[0]?.checkpointId).toBe("c");
  });

  test("a refusal carries the race winner", async () => {
    const e = (await client.refusalWithWinner
      .query()
      .catch((x: unknown) => x)) as TRPCClientError<TestRouter>;
    expect(e.data?.details?.winner).toEqual({
      checkpointId: "c",
      kind: "approved",
      actorName: "Ada",
    });
  });

  test("a refusal without details leaves details undefined", async () => {
    const e = (await client.refusalNoDetails
      .query()
      .catch((x: unknown) => x)) as TRPCClientError<TestRouter>;
    expect(e.data?.code).toBe("FORBIDDEN");
    expect(e.data?.details).toBeUndefined();
    expect(e.data).not.toHaveProperty("details");
  });

  test("a plain TRPCError keeps its shape: no details key on the wire", async () => {
    const e = (await client.plainError
      .query()
      .catch((x: unknown) => x)) as TRPCClientError<TestRouter>;
    expect(e.data?.code).toBe("NOT_FOUND");
    expect(e.message).toBe("missing");
    expect(e.data).not.toHaveProperty("details");
  });

  test("a TRPCError with an unrelated cause gets no details", async () => {
    const e = (await client.plainErrorWithCause
      .query()
      .catch((x: unknown) => x)) as TRPCClientError<TestRouter>;
    expect(e.data?.code).toBe("BAD_REQUEST");
    expect(e.data).not.toHaveProperty("details");
  });

  test("reviewError builds a TRPCError with the requested code and message", () => {
    const err = reviewError("PRECONDITION_FAILED", "stale", {
      reasons: [{ checkpointId: "c1", reason: "already_decided" }],
    });
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toBe("stale");
  });
});

describe("review metrics", () => {
  test("recordReviewDecisions counts by decision and source", async () => {
    const registry = new Registry();
    recordReviewDecisions(registry, "approved", "viewer", 1);
    recordReviewDecisions(registry, "approved", "viewer", 2);
    recordReviewDecisions(registry, "rejected", "batch", 5);

    const values = metricValues(
      await registry.getMetricsAsJSON(),
      "furan_review_decisions_total",
    );
    expect(values).toContainEqual({
      labels: { decision: "approved", source: "viewer" },
      value: 3,
    });
    expect(values).toContainEqual({
      labels: { decision: "rejected", source: "batch" },
      value: 5,
    });
  });

  test("recordReviewRevert counts by outcome", async () => {
    const registry = new Registry();
    recordReviewRevert(registry, "reverted", 4);
    recordReviewRevert(registry, "skipped", 2);
    recordReviewRevert(registry, "reverted", 1);

    const values = metricValues(
      await registry.getMetricsAsJSON(),
      "furan_review_reverts_total",
    );
    expect(values).toContainEqual({
      labels: { outcome: "reverted" },
      value: 5,
    });
    expect(values).toContainEqual({
      labels: { outcome: "skipped" },
      value: 2,
    });
  });

  test("recordReviewRevertRefused counts by reason", async () => {
    const registry = new Registry();
    const reason = "history_expired" as const;
    recordReviewRevertRefused(registry, reason);
    recordReviewRevertRefused(registry, reason);

    const values = metricValues(
      await registry.getMetricsAsJSON(),
      "furan_review_revert_refused_total",
    );
    expect(values).toContainEqual({ labels: { reason }, value: 2 });
  });

  test("a zero, negative or non-finite count records nothing and never throws", async () => {
    const registry = new Registry();
    expect(() => {
      recordReviewDecisions(registry, "approved", "sdk", 0);
      recordReviewDecisions(registry, "approved", "sdk", -3);
      recordReviewDecisions(registry, "approved", "sdk", Infinity);
      recordReviewRevert(registry, "skipped", 0);
      recordReviewRevert(registry, "skipped", Number.NaN);
      recordReviewRevert(registry, "skipped", Infinity);
    }).not.toThrow();
    const json = await registry.getMetricsAsJSON();
    expect(metricValues(json, "furan_review_decisions_total")).toEqual([]);
    expect(metricValues(json, "furan_review_reverts_total")).toEqual([]);
  });

  test("metrics are per-registry (no cross-registry bleed)", async () => {
    const a = new Registry();
    const b = new Registry();
    recordReviewRevert(a, "reverted", 3);
    recordReviewRevert(b, "reverted", 7);

    const av = metricValues(
      await a.getMetricsAsJSON(),
      "furan_review_reverts_total",
    );
    const bv = metricValues(
      await b.getMetricsAsJSON(),
      "furan_review_reverts_total",
    );
    expect(av).toContainEqual({ labels: { outcome: "reverted" }, value: 3 });
    expect(bv).toContainEqual({ labels: { outcome: "reverted" }, value: 7 });
  });
});
