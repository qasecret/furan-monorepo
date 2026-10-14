import type { AddressInfo } from "node:net";

import {
  createDb,
  eq,
  recomputeRunStatus,
  screenshots,
  sql,
  testRuns,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Broadcaster } from "../src/lib/broadcast.js";
import type { ReviewActionCtx } from "../src/lib/review/actions.js";
import { rejectPendingInRuns } from "../src/lib/review/legacy.js";
import { lockRuns } from "../src/lib/review/targets.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * Lock discipline of two legacy review paths (Ruling R21):
 *  - `runs.overrideStatus` reads the status its legality gate checks only
 *    after it holds the run's row lock, so a concurrent writer that moves the
 *    run (a revert or a re-diff making it `running`) cannot slip between the
 *    check and the write;
 *  - `rejectPendingInRuns` (`inbox.rejectCluster`) applies its run cap
 *    before it locks, so it locks only the runs it will decide.
 */
const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

const quietLogger = { info: () => undefined, error: () => undefined };

/** "ok", or the SQLSTATE drizzle's wrapped driver error carries. */
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    let cur: unknown = err;
    for (let depth = 0; cur && depth < 5; depth++) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      cur = (cur as { cause?: unknown }).cause;
    }
    return String(err);
  }
}

d("review locking (R21)", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    // The app logs the refusal this suite expects at error level; the outcome
    // is asserted through the response and the rows instead.
    h.app.log.level = "silent";
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  function clientFor(jwt: string) {
    return createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}/trpc`,
          headers: { authorization: `Bearer ${jwt}` },
        }),
      ],
    });
  }

  test("overrideStatus checks legality under the run lock: a run a concurrent writer makes `running` is refused", async () => {
    const s = await seedReviewRun(h, {
      checkpoints: [{ name: "a", verdict: "unresolved" }],
    });
    seeds.push(s);

    const side = createDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    let sidePid = 0;
    // A concurrent re-diff: holds the run lock, clears the verdict and
    // recomputes (→ running), and commits only when released.
    const sideDone = side.db.transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      sidePid = pid!.pid;
      await lockRuns(tx, s.projectId, [s.runId]);
      await tx
        .update(screenshots)
        .set({ verdict: null, verdictAt: null })
        .where(eq(screenshots.runId, s.runId));
      const { after } = await recomputeRunStatus(tx, s.runId);
      expect(after).toBe("running");
      locked();
      await gate;
    });
    sideDone.catch(() => locked());

    let call: Promise<unknown> = Promise.resolve();
    try {
      await lockedP;
      call = clientFor(s.editor.jwt).runs.overrideStatus.mutate({
        runId: s.runId,
        status: "passed",
      });
      call.catch(() => undefined);
      // The override is now parked on the run lock.
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const r = await h.db.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock'
            and ${sidePid}::int = any(pg_blocking_pids(pid))
        `);
        waiting = r[0]!.n > 0;
        if (!waiting) await new Promise((r2) => setTimeout(r2, 25));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await sideDone;
      await side.close();
    }

    await expect(call).rejects.toMatchObject({
      data: { code: "BAD_REQUEST" },
      message: "Cannot override status from 'running'.",
    });
    const [run] = await h.db
      .select({ status: testRuns.status, override: testRuns.statusOverride })
      .from(testRuns)
      .where(eq(testRuns.id, s.runId));
    expect(run).toEqual({ status: "running", override: null });
  });

  test("rejectPendingInRuns caps before it locks: runs past the cap, and runs with nothing pending, stay unlocked", async () => {
    // Nothing pending on run0; one pending checkpoint on each of r1..r3.
    const s = await seedReviewRun(h, {
      checkpoints: [{ name: "p0", verdict: "passed" }],
    });
    seeds.push(s);
    const r1 = await addReviewRun(h, s, {
      checkpoints: [{ name: "p1", verdict: "unresolved" }],
    });
    const r2 = await addReviewRun(h, s, {
      checkpoints: [{ name: "p2", verdict: "unresolved" }],
    });
    const r3 = await addReviewRun(h, s, {
      checkpoints: [{ name: "p3", verdict: "unresolved" }],
    });
    // The caller's (cluster priority) order, not capture order.
    const order = [s.runId, r3.runId, r1.runId, r2.runId];

    const probe = createDb();
    const ctxFor = (tx: ReviewActionCtx["tx"]): ReviewActionCtx => ({
      tx,
      actor: { id: s.editor.id, role: "editor", via: "jwt" },
      deps: { registry: h.telemetry.metrics, logger: quietLogger },
      broadcaster: {
        publishProjectEvent: async () => undefined,
      } as unknown as Broadcaster,
      onCommit: () => undefined,
    });
    /** Whether another session can take the run's lock right now. */
    const lockable = (runId: string) =>
      sqlState(
        probe.db.transaction(async (ptx) => {
          await ptx.execute(
            sql`select id from test_runs where id = ${runId} for no key update nowait`,
          );
        }),
      );

    try {
      const first = await h.db.transaction(async (tx) => {
        const res = await rejectPendingInRuns(ctxFor(tx), {
          projectId: s.projectId,
          runIds: order,
          runCap: 2,
          source: "inbox",
        });
        const locks: Record<string, string> = {};
        for (const [name, id] of Object.entries({
          run0: s.runId,
          r1: r1.runId,
          r2: r2.runId,
          r3: r3.runId,
        })) {
          locks[name] = await lockable(id);
        }
        return { res, locks };
      });

      // The cap counts runs with something pending, in the caller's order.
      expect(new Set(first.res.runs.map((r) => r.runId))).toEqual(
        new Set([r3.runId, r1.runId]),
      );
      expect(first.res.capped).toBe(true);
      expect(first.res.cap).toBe(2);
      // Only the decided runs were locked (55P03 = lock_not_available).
      expect(first.locks).toEqual({
        run0: "ok",
        r1: "55P03",
        r2: "ok",
        r3: "55P03",
      });

      // A re-run drains what the cap left.
      const second = await h.db.transaction((tx) =>
        rejectPendingInRuns(ctxFor(tx), {
          projectId: s.projectId,
          runIds: order,
          runCap: 2,
          source: "inbox",
        }),
      );
      expect(second.runs.map((r) => r.runId)).toEqual([r2.runId]);
      expect(second.capped).toBe(false);
    } finally {
      await probe.close();
    }
  });
});
