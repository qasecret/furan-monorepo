import { randomUUID } from "node:crypto";

import { eq, inArray, screenshots, testRuns } from "@furan/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { GROUP_APPROVE_CAP } from "../src/lib/review/groups.js";
import {
  selectGroupTargets,
  selectPendingTargets,
} from "../src/lib/review/targets.js";
import type { Context } from "../src/trpc/context.js";
import { runsRouter } from "../src/trpc/v1/runs.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  cp,
  decideDirectly,
  failDiff,
  seedReviewRun,
  type ReviewCheckpointSpec,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * A checkpoint's group is selected in SQL (`selectGroupTargets`, spec
 * 2026-10-27 §4, "`runs.getCheckpointGroup`"; budget R5) and selects exactly
 * what the decision core's JS selection (`selectPendingTargets` over the
 * group's scope, i.e. `collectLegalTargets` for "approve") accepts: the same
 * steps, in the same capture order.
 */

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

/** Every target the JS selection keeps (no cap). */
const ALL = Number.MAX_SAFE_INTEGER;

d("the group selection in SQL equals the decision core's", () => {
  let h: TestApp;
  const seeds: ReviewSeed[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
  });
  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  async function seed(checkpoints: ReviewCheckpointSpec[]) {
    const s = await seedReviewRun(h, { checkpoints });
    seeds.push(s);
    return s;
  }

  /** Gives `shotIds` the diff signature `sig`. */
  async function sign(sig: string, shotIds: string[]): Promise<void> {
    await h.db
      .update(screenshots)
      .set({ diffSignature: sig })
      .where(inArray(screenshots.id, shotIds));
  }

  const key = (t: { runId: string; screenshotId: string }) =>
    `${t.runId}:${t.screenshotId}`;

  /** Both selections of a group, as `run:step` keys in their order. */
  async function both(
    projectId: string,
    buildId: string,
    diffSignature: string,
    limit: number,
  ) {
    const js = await selectPendingTargets(
      h.db,
      { projectId, buildId, diffSignature },
      ALL,
    );
    const viaSql = await selectGroupTargets(h.db, {
      projectId,
      buildId,
      diffSignature,
      limit,
    });
    return {
      js: js.targets.map(key),
      sql: viaSql.targets.map(key),
      total: viaSql.total,
      targets: viaSql.targets,
    };
  }

  test("selectGroupTargets equals the JS selection: legality, signature, build, project and capture order", async () => {
    const S1 = `s1-${randomUUID()}`;
    const S2 = `s2-${randomUUID()}`;
    // r0: a, b pending; c passed; d pending on another signature.
    const s = await seed([
      cp("a", "unresolved"),
      cp("b", "new"),
      cp("c", "passed"),
      cp("d", "unresolved"),
    ]);
    // r1: e approved, f rejected, g's approval undone (pending again).
    const r1 = await addReviewRun(h, s, {
      checkpoints: [
        cp("e", "unresolved"),
        cp("f", "unresolved"),
        cp("g", "unresolved"),
      ],
    });
    // r2: h pending but its diff failed (not approvable); i pending.
    const r2 = await addReviewRun(h, s, {
      checkpoints: [cp("h", "unresolved"), cp("i", "new")],
    });
    // r3 running, r4 aborted, r5 overridden, r6 with an undiffed sibling:
    // none of their steps can be decided.
    const r3 = await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [cp("j", "unresolved")],
    });
    const r4 = await addReviewRun(h, s, {
      lifecycle: "aborted",
      checkpoints: [cp("k", "unresolved")],
    });
    const r5 = await addReviewRun(h, s, {
      override: "passed",
      checkpoints: [cp("l", "unresolved")],
    });
    const r6 = await addReviewRun(h, s, {
      lifecycle: "failed",
      checkpoints: [cp("m", "unresolved"), cp("n", null)],
    });
    // r7, r8: captured at the same instant, so the run id orders them; r8's
    // id is the lower one although it was captured second.
    const [low, high] = [randomUUID(), randomUUID()].sort();
    const r7 = await addReviewRun(h, s, {
      runId: high!,
      checkpoints: [cp("o", "unresolved")],
    });
    const r8 = await addReviewRun(h, s, {
      runId: low!,
      checkpoints: [cp("p", "new")],
    });
    const [r7Row] = await h.db
      .select({ createdAt: testRuns.createdAt })
      .from(testRuns)
      .where(eq(testRuns.id, r7.runId));
    await h.db
      .update(testRuns)
      .set({ createdAt: r7Row!.createdAt })
      .where(eq(testRuns.id, r8.runId));
    // r9: two steps captured at the same instant, ordered by step id.
    const r9 = await addReviewRun(h, s, {
      checkpoints: [cp("q1", "unresolved"), cp("q2", "unresolved")],
    });
    const [q1, q2] = [r9.shots.q1!, r9.shots.q2!];
    const [q1Row] = await h.db
      .select({ createdAt: screenshots.createdAt })
      .from(screenshots)
      .where(eq(screenshots.id, q1.id));
    await h.db
      .update(screenshots)
      .set({ createdAt: q1Row!.createdAt })
      .where(eq(screenshots.id, q2.id));
    // Another batch of the project, and another project's run moved into
    // this batch (a corrupt state the selection must not reach).
    const other = await addReviewBuild(h, s, {
      spec: { checkpoints: [cp("x", "unresolved")] },
    });
    const foreign = await seed([cp("y", "unresolved")]);
    await h.db
      .update(testRuns)
      .set({ buildId: s.buildId })
      .where(eq(testRuns.id, foreign.runId));

    const at =
      (run: { runId: string; shots: Record<string, { id: string }> }) =>
      (name: string) => ({ runId: run.runId, id: run.shots[name]!.id });
    const r0 = at(s);
    const all = [
      r0("a"),
      r0("b"),
      r0("c"),
      at(r1)("e"),
      at(r1)("f"),
      at(r1)("g"),
      at(r2)("h"),
      at(r2)("i"),
      at(r3)("j"),
      at(r4)("k"),
      at(r5)("l"),
      at(r6)("m"),
      at(r7)("o"),
      at(r8)("p"),
      { runId: r9.runId, id: q1.id },
      { runId: r9.runId, id: q2.id },
      at(other)("x"),
      at(foreign)("y"),
    ];
    await sign(
      S1,
      all.map((x) => x.id),
    );
    await sign(S2, [r0("d").id]);
    await decideDirectly(h, s, [at(r1)("e").id]);
    await decideDirectly(h, s, [at(r1)("f").id], { decision: "rejected" });
    await decideDirectly(h, s, [at(r1)("g").id], { reverted: true });
    await failDiff(h, at(r2)("h").id);

    const k = (x: { runId: string; id: string }) => `${x.runId}:${x.id}`;
    const [qa, qb] = [q1, q2].sort((x, y) => (x.id < y.id ? -1 : 1));
    const expected = [
      r0("a"),
      r0("b"),
      at(r1)("g"),
      at(r2)("i"),
      at(r8)("p"),
      at(r7)("o"),
      { runId: r9.runId, id: qa!.id },
      { runId: r9.runId, id: qb!.id },
    ].map(k);

    const s1 = await both(s.projectId, s.buildId, S1, 201);
    expect(s1.js).toEqual(expected);
    expect(s1.sql).toEqual(s1.js);
    expect(s1.total).toBe(expected.length);
    // The names the group read shows come with each target.
    expect(s1.targets[0]).toMatchObject({
      name: "a",
      viewport: "1280x720",
      testName: `run-${s.tag}`,
    });

    // The other signature, one with no member, and the other batch.
    const s2 = await both(s.projectId, s.buildId, S2, 201);
    expect(s2.sql).toEqual([k(r0("d"))]);
    expect(s2.sql).toEqual(s2.js);
    expect(s2.total).toBe(1);
    const none = await both(s.projectId, s.buildId, `none-${S1}`, 201);
    expect(none).toMatchObject({ js: [], sql: [], total: 0 });
    const there = await both(s.projectId, other.buildId, S1, 201);
    expect(there.sql).toEqual([k(at(other)("x"))]);
    expect(there.sql).toEqual(there.js);

    // Asked under the other project, the batch holds only that project's
    // own run: none of this project's steps.
    const foreignAsk = await both(foreign.projectId, s.buildId, S1, 201);
    expect(foreignAsk.sql).toEqual([k(at(foreign)("y"))]);
    expect(foreignAsk.sql).toEqual(foreignAsk.js);
    expect(foreignAsk.total).toBe(1);

    // A limit keeps the first members in capture order; the total is all.
    for (const limit of [1, 2, 5, 8]) {
      const capped = await both(s.projectId, s.buildId, S1, limit);
      expect(capped.sql, `limit ${limit}`).toEqual(expected.slice(0, limit));
      expect(capped.total, `limit ${limit}`).toBe(expected.length);
    }
  });

  test("the group caps at 201 and reports the true total", async () => {
    const S = `cap-${randomUUID()}`;
    const steps = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => cp(`${prefix}${i}`, "unresolved"));
    // 250 pending members over three runs, and one decided step.
    const s = await seed(steps("a", 100));
    const r1 = await addReviewRun(h, s, { checkpoints: steps("b", 100) });
    const r2 = await addReviewRun(h, s, {
      checkpoints: [...steps("c", 50), cp("decided", "unresolved")],
    });
    const members = [
      ...s.shotsInOrder.map((x) => ({ runId: s.runId, id: x.id })),
      ...r1.shotsInOrder.map((x) => ({ runId: r1.runId, id: x.id })),
      ...r2.shotsInOrder.map((x) => ({ runId: r2.runId, id: x.id })),
    ];
    const decided = members.pop()!;
    await sign(S, [...members.map((x) => x.id), decided.id]);
    await decideDirectly(h, s, [decided.id]);

    const limit = GROUP_APPROVE_CAP + 1;
    const capped = await both(s.projectId, s.buildId, S, limit);
    expect(capped.js).toHaveLength(250);
    expect(capped.sql).toHaveLength(limit);
    expect(capped.sql).toEqual(capped.js.slice(0, limit));
    expect(capped.total).toBe(250);

    /** `runs.getCheckpointGroup` for one step, as an admin. */
    const group = (seedStep: { runId: string; id: string }) =>
      runsRouter
        .createCaller({
          user: { id: s.admin.id, role: "admin", via: "jwt" },
          db: h.db,
        } as unknown as Context)
        .getCheckpointGroup({
          runId: seedStep.runId,
          checkpointId: seedStep.id,
        });
    const ids = (res: Awaited<ReturnType<typeof group>>) =>
      res.checkpoints.map((c) => c.id);
    const memberIds = members.map((x) => x.id);

    // From the first member: the next 200, capped.
    const first = await group(members[0]!);
    expect(first).toMatchObject({ checkpointCount: 200, capped: true });
    expect(ids(first)).toEqual(memberIds.slice(1, 201));
    // From the last member (beyond the first 201): the first 200, capped.
    const last = await group(members[249]!);
    expect(last).toMatchObject({ checkpointCount: 200, capped: true });
    expect(ids(last)).toEqual(memberIds.slice(0, 200));
    // From the decided step: not a member itself, the first 200, capped.
    const fromDecided = await group(decided);
    expect(fromDecided).toMatchObject({ checkpointCount: 200, capped: true });
    expect(ids(fromDecided)).toEqual(memberIds.slice(0, 200));

    // Down to 201 members: from a member the other 200 fit, from the decided
    // step all 201 do not.
    await decideDirectly(
      h,
      s,
      members.slice(201).map((x) => x.id),
    );
    const at201 = await both(s.projectId, s.buildId, S, limit);
    expect(at201.total).toBe(201);
    expect(at201.sql).toEqual(at201.js);
    const fromMember = await group(members[0]!);
    expect(fromMember).toMatchObject({ checkpointCount: 200, capped: false });
    expect(ids(fromMember)).toEqual(memberIds.slice(1, 201));
    const fromDecided201 = await group(decided);
    expect(fromDecided201).toMatchObject({
      checkpointCount: 200,
      capped: true,
    });
    expect(ids(fromDecided201)).toEqual(memberIds.slice(0, 200));
    // Each is what the JS selection gives, the seed left out.
    const js = (
      await selectPendingTargets(
        h.db,
        { projectId: s.projectId, buildId: s.buildId, diffSignature: S },
        ALL,
      )
    ).targets.map((t) => t.screenshotId);
    expect(ids(fromMember)).toEqual(
      js.filter((id) => id !== members[0]!.id).slice(0, 200),
    );
  });
});
