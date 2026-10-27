import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { createTRPCClient, httpLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewSeed,
  type ReviewUser,
} from "./review-fixtures.js";

/**
 * What `review.approve` of one step costs on the wire (spec 2026-10-27 §7,
 * budget: at most 15 statements). Counted from the API's own connection pool
 * (postgres.js's `debug` hook), so every statement the procedure sends is
 * seen: the membership gate's, savepoints, writes and the audit row's.
 *
 * Counted: everything after the request transaction's own scope statement
 * (`set_config('app.user_id', …)`) and before its COMMIT. Not counted: the
 * transaction's BEGIN and COMMIT, that scope statement, and the soft
 * authenticator's user lookup before the transaction (a cache miss only).
 *
 * The statements are pinned one by one: the run, its lock, the replay check
 * and the target facts are each read once.
 */

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

/** The one-step approve budget (spec 2026-10-27 §7). */
const APPROVE_ONE_STEP_BUDGET = 15;

/** What a wire statement does, by its SQL. */
function kind(q: string): string {
  const s = q.replace(/\s+/g, " ").trim();
  const rules: Array<[RegExp, string]> = [
    [/set_config\('app\.user_role', 'owner', true\)/, "gate: elevate"],
    [/^WITH resolved AS MATERIALIZED/, "gate: project + membership"],
    [/^select "project_id" from "test_runs"/i, "run: project"],
    [/^SELECT "test_runs"\."project_id" FROM "test_runs"/, "run: project"],
    [/^select .* from "test_runs" .*for no key update$/i, "run: lock"],
    [/from "checkpoint_decisions" where .*"action_id" = /i, "replay check"],
    [/from "screenshots" inner join "test_runs"/i, "target facts"],
    [/from "test_variations" .*for no key update$/i, "variations: lock"],
    [/^savepoint /i, "savepoint"],
    [/from "baselines" .*for no key update$/i, "baseline: lock prior"],
    [/^update "test_variations"/i, "variation: write"],
    [/^insert into "baselines"/i, "baseline: write"],
    [/^insert into "checkpoint_decisions"/i, "decision: write"],
    [/from "test_runs" left join lateral/i, "run: rollup inputs"],
    [/^update "test_runs"/i, "run: write status + counters"],
    [/^insert into "audit_log"/i, "audit: write"],
  ];
  for (const [re, label] of rules) if (re.test(s)) return label;
  return `other: ${s.slice(0, 90)}`;
}

/** The procedure's own statements: after the request scope's, before COMMIT. */
function procedureStatements(log: readonly string[]): string[] {
  const scopeAt = log.findIndex((q) => q.includes("set_config('app.user_id'"));
  const commitAt = log.findIndex((q) => /^commit\b/i.test(q.trim()));
  expect(scopeAt).toBeGreaterThanOrEqual(0);
  expect(commitAt).toBeGreaterThan(scopeAt);
  return log.slice(scopeAt + 1, commitAt);
}

/** After the gate (or, for an admin, the handler's own project read). */
const DECISION_STATEMENTS = [
  "run: lock",
  "replay check",
  "target facts",
  "variations: lock",
  "savepoint",
  "baseline: lock prior",
  "variation: write",
  "baseline: write",
  "decision: write",
  "run: rollup inputs",
  "run: write status + counters",
  "savepoint",
  "audit: write",
];

d("review.approve of one step: statements on the wire", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];
  /** Statements the API's pool sent while recording. */
  let wireLog: string[] | null = null;

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    // Every statement the app's pool sends, read live by postgres.js.
    const client = (
      h.app.db as unknown as { $client: { options: { debug: unknown } } }
    ).$client;
    client.options.debug = (_conn: number, query: string) => {
      wireLog?.push(query);
    };
  });

  afterAll(async () => {
    if (h) {
      await cleanupReviewSeeds(h, seeds);
      await h.close();
    }
  });

  const api = (u: ReviewUser) =>
    createTRPCClient<AppRouter>({
      links: [
        httpLink({
          url: `${baseUrl}/trpc`,
          headers: { authorization: `Bearer ${u.jwt}` },
        }),
      ],
    });

  /** A run with two pending steps: approving one leaves the run pending. */
  async function seed(): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, {
      checkpoints: [
        { name: "home", verdict: "unresolved", withBaseline: true },
        { name: "cart", verdict: "unresolved" },
      ],
    });
    seeds.push(s);
    return s;
  }

  async function wireOf(call: () => Promise<unknown>): Promise<string[]> {
    const log: string[] = [];
    wireLog = log;
    try {
      await call();
    } finally {
      wireLog = null;
    }
    return procedureStatements(log);
  }

  test.each([
    ["approve of one step", false],
    ["approve of one step with reviewer-drawn ignore areas", true],
  ] as const)(
    `%s issues at most ${APPROVE_ONE_STEP_BUDGET} statements (a member)`,
    async (_name, withAreas) => {
      const s = await seed();
      const statements = await wireOf(() =>
        api(s.editor).review.approve.mutate({
          runId: s.runId,
          actionId: randomUUID(),
          checkpointIds: [s.shots.home!.id],
          ...(withAreas
            ? {
                ignoreAreas: [
                  { x: 1, y: 2, width: 3, height: 4, viewport: "1280x720" },
                ],
              }
            : {}),
        }),
      );
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.map(kind)).toEqual([
        "gate: elevate",
        "gate: project + membership",
        ...DECISION_STATEMENTS,
      ]);
      expect(statements.length).toBe(15);
      expect(statements.length).toBeLessThanOrEqual(APPROVE_ONE_STEP_BUDGET);
    },
  );

  test("an admin skips the gate: the handler reads the run's project once", async () => {
    const s = await seed();
    const statements = await wireOf(() =>
      api(s.admin).review.approve.mutate({
        runId: s.runId,
        actionId: randomUUID(),
        checkpointIds: [s.shots.home!.id],
      }),
    );
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.map(kind)).toEqual([
      "run: project",
      ...DECISION_STATEMENTS,
    ]);
    expect(statements.length).toBe(14);
  });
});
