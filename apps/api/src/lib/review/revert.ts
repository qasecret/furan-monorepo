import {
  and,
  asc,
  baselines,
  checkpointDecisions,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  recomputeRunStatus,
  screenshots,
  sql,
  testVariations,
  type CheckpointDecisionRow,
  type DB,
  type Tx,
  type VariationIdentity,
} from "@furan/db";
import {
  decisionSnapshotSchema,
  type DecisionSnapshot,
  type RevertSkipReason,
  type RunStatus,
} from "@furan/shared-types";

import type { AuthedUser } from "../../plugins/auth.js";
import { emitAudit } from "../emit-audit.js";
import { isAtLeastAdmin } from "../roles.js";

import type { DecideDeps } from "./decide.js";
import { reviewError } from "./errors.js";
import { recordReviewRevert, recordReviewRevertRefused } from "./metrics.js";
import { lockRuns, lockVariations } from "./targets.js";

/**
 * Undo (spec §5.3): puts back what a review action's decisions replaced, as
 * their `before` snapshots recorded it, until something newer has built on
 * top of it. `assessRevert` says whether each decision can still be undone;
 * `revertAction` undoes a whole action.
 */

export interface RevertInput {
  actor: AuthedUser;
  actionId: string;
  /**
   * The project the caller resolved and gated. When given, only the action's
   * decisions in that project are considered (an action id is unique per
   * project, not globally); when omitted it is derived from the decisions.
   */
  projectId?: string;
}

export type RevertDeps = DecideDeps;

export interface RevertResult {
  actionId: string;
  /** Decisions undone. */
  reverted: number;
  /** Decisions left as they were, in the order the action wrote them. */
  skipped: Array<{ checkpointId: string; reason: RevertSkipReason }>;
  /**
   * Runs (ascending id) with at least one approve undone: the caller must
   * enqueue a re-diff for each after commit (R28). A checkpoint re-diffed
   * since its approve had its verdict computed against the baseline just
   * undone, so it is cleared here and its run is `running` until the re-diff
   * lands. For every other undone approve the verdict stands, but a diff job
   * already in flight when the undo committed may still write a verdict
   * computed against that baseline; the re-diff corrects it.
   *
   * A retry (R30) also names a run whose approve was already undone while any
   * of its checkpoints still has no verdict: the caller's enqueue after the
   * first commit may have been lost (queue down), and nothing else would ever
   * re-queue it.
   */
  rediffRunIds: string[];
  /** Each of the action's runs and its status afterwards, ascending run id. */
  runs: Array<{ runId: string; status: RunStatus }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rows per `reverted_at` UPDATE (one bind parameter each). */
const UPDATE_CHUNK = 1_000;

// ---------------------------------------------------------------------------
// Snapshot checks (pure)
// ---------------------------------------------------------------------------

type VariationSnapshot = NonNullable<DecisionSnapshot["variation"]>;
/** The variation fields an approve writes (and an undo puts back). */
type VariationFields = NonNullable<DecisionSnapshot["variationAfter"]>;

/** Those fields of a variation snapshot or row (`undefined` read as null). */
const fieldsOf = (v: {
  baselineName: string | null;
  matchLevel: string;
  ignoreRegions: unknown;
  layoutRegions: unknown;
  floatingRegions: unknown;
  contentRegions: unknown;
  accessibilityRegions: unknown;
}): VariationFields => ({
  baselineName: v.baselineName,
  matchLevel: v.matchLevel,
  ignoreRegions: v.ignoreRegions ?? null,
  layoutRegions: v.layoutRegions ?? null,
  floatingRegions: v.floatingRegions ?? null,
  contentRegions: v.contentRegions ?? null,
  accessibilityRegions: v.accessibilityRegions ?? null,
});

/**
 * JSON equality by value: object keys in any order, arrays in order. Both
 * sides come back from jsonb, where SQL NULL and a JSON null both read as null.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => jsonEqual(x, b[i]))
    );
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        jsonEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}

const sameFields = (a: VariationFields, b: VariationFields): boolean =>
  a.baselineName === b.baselineName &&
  a.matchLevel === b.matchLevel &&
  jsonEqual(a.ignoreRegions, b.ignoreRegions) &&
  jsonEqual(a.layoutRegions, b.layoutRegions) &&
  jsonEqual(a.floatingRegions, b.floatingRegions) &&
  jsonEqual(a.contentRegions, b.contentRegions) &&
  jsonEqual(a.accessibilityRegions, b.accessibilityRegions);

/** An approve's snapshot, checked to be restorable; ids lowercased. */
interface ApproveRestore {
  baseline:
    | { op: "inserted"; id: string }
    | {
        op: "updated";
        id: string;
        prev: {
          baselineName: string | null;
          userId: string | null;
          branchName: string;
          /** µs-exact ISO text, restored through SQL (never a JS Date). */
          createdAt: string;
          updatedAt: string;
        };
        /** `prev.createdAt` in µs since the epoch, for ordering only. */
        prevCreatedMicros: bigint;
      };
  variation: VariationSnapshot;
  /**
   * The variation as the approve wrote it (R25); null on a snapshot written
   * before it was recorded, which skips the edit check.
   */
  variationAfter: VariationFields | null;
}

type Classified =
  | { kind: "skip"; reason: RevertSkipReason }
  | { kind: "reject" }
  | { kind: "approve"; restore: ApproveRestore };

const skipFor = (reason: RevertSkipReason): Classified => ({
  kind: "skip",
  reason,
});

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * An ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS[.ffffff](Z|±HH:MM)`) as µs since
 * the epoch, or null when it isn't one Postgres would read back unchanged.
 */
export function isoToMicros(s: string): bigint | null {
  const m = ISO_TIMESTAMP.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec);
  const t = new Date(ms);
  // Date.UTC normalises overflow (Feb 31 → Mar 3, hour 24 → next day) and
  // maps years 0–99 to 19xx; a round trip rejects all of them.
  if (
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() !== mo - 1 ||
    t.getUTCDate() !== d ||
    t.getUTCHours() !== h ||
    t.getUTCMinutes() !== mi ||
    t.getUTCSeconds() !== sec
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (m[8] !== undefined) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 15 || om > 59) return null;
    offsetMinutes = (m[8] === "+" ? 1 : -1) * (oh * 60 + om);
  }
  const micros = BigInt((m[7] ?? "").padEnd(6, "0"));
  return (BigInt(ms) - BigInt(offsetMinutes) * 60_000n) * 1_000n + micros;
}

/**
 * What a decision's own row says, before any lookup: already undone, no
 * snapshot, a snapshot that can't be restored, or a reject / a restorable
 * approve. Beyond the schema, an approve must name a baseline row and a
 * variation by uuid and, for `updated`, carry timestamps and a user id that
 * Postgres accepts; anything else would fail half-way through a restore.
 */
function classify(
  d: Pick<CheckpointDecisionRow, "revertedAt" | "before" | "decision">,
): Classified {
  if (d.revertedAt !== null) return skipFor("already_undone");
  if (d.before === null) return skipFor("not_undoable_legacy");
  const parsed = decisionSnapshotSchema.safeParse(d.before);
  if (!parsed.success) return skipFor("history_corrupt");
  if (d.decision === "rejected") return { kind: "reject" };

  const { baseline, variation } = parsed.data;
  const variationAfter = parsed.data.variationAfter
    ? fieldsOf(parsed.data.variationAfter)
    : null;
  if (
    !baseline ||
    !variation ||
    !UUID.test(baseline.id) ||
    !UUID.test(variation.id)
  ) {
    return skipFor("history_corrupt");
  }
  const restoredVariation = { ...variation, id: variation.id.toLowerCase() };
  const id = baseline.id.toLowerCase();
  if (baseline.op === "inserted") {
    return {
      kind: "approve",
      restore: {
        baseline: { op: "inserted", id },
        variation: restoredVariation,
        variationAfter,
      },
    };
  }
  const { prev } = baseline;
  const prevCreatedMicros = isoToMicros(prev.createdAt);
  if (
    prevCreatedMicros === null ||
    isoToMicros(prev.updatedAt) === null ||
    (prev.userId !== null && !UUID.test(prev.userId))
  ) {
    return skipFor("history_corrupt");
  }
  return {
    kind: "approve",
    restore: {
      baseline: { op: "updated", id, prev, prevCreatedMicros },
      variation: restoredVariation,
      variationAfter,
    },
  };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** A decision's action: an action id is unique per project, not globally. */
const actionKey = (d: Pick<CheckpointDecisionRow, "projectId" | "actionId">) =>
  `${d.projectId}:${d.actionId}`;

/** A `baselines` row as the newest-baseline check sees it. */
interface BaselineState {
  id: string;
  variationId: string;
  runId: string;
  branch: string;
  /** `created_at` in µs since the epoch. */
  micros: bigint;
}

/** True when `a` sorts after `b` in `created_at DESC, id DESC` (ADR-068). */
const isNewer = (a: BaselineState, b: BaselineState): boolean =>
  a.micros > b.micros || (a.micros === b.micros && a.id > b.id);

const pairKey = (variationId: string, branch: string) =>
  `${variationId}\u0000${branch}`;

const epochMicros = (col: typeof baselines.createdAt) =>
  sql<string>`(extract(epoch from ${col}) * 1000000)::bigint::text`;

/**
 * The fields of a variation's ADR-054 identity (`VariationIdentity`: the
 * identity minus the project and branch scoping), one entry each. Typed as a
 * `Record` over the interface's keys, adding a field to `VariationIdentity`
 * fails typecheck here until it takes part in sibling matching; the selects
 * below, whose rows must satisfy `VariationIdentity`, fail the same way.
 */
const IDENTITY_FIELDS: Record<keyof VariationIdentity, true> = {
  name: true,
  viewport: true,
  browser: true,
  os: true,
  device: true,
};
const IDENTITY_KEYS = Object.keys(IDENTITY_FIELDS) as Array<
  keyof VariationIdentity
>;

type Identity = VariationIdentity & { projectId: string };

/** Equal for variations of one project with the same identity, whatever the branch. */
const identityKey = (i: Identity): string =>
  JSON.stringify([i.projectId, ...IDENTITY_KEYS.map((k) => i[k])]);

/** Everything the approve checks need, loaded in a fixed number of queries. */
interface ApproveFacts {
  /** The baseline rows the approves wrote, by id (absent: deleted since). */
  rows: Map<string, BaselineState>;
  /** The same rows, by variation. */
  rowsByVariation: Map<string, BaselineState[]>;
  /**
   * Per (variation, branch), the newest row that NO approve being assessed
   * wrote. Rows the approves wrote are judged through the simulation instead.
   */
  staticNewest: Map<string, BaselineState>;
  /** The snapshot variations that exist, as they are now. */
  variations: Map<string, VariationFields>;
  /**
   * Decisions with a capture of their variation or a sibling, in another run,
   * made (`created_at`) or re-diffed (`verdict_at`, R24) after them.
   */
  newerCapture: Set<string>;
}

async function loadApproveFacts(
  db: DB | Tx,
  approves: ReadonlyArray<{
    d: CheckpointDecisionRow;
    restore: ApproveRestore;
  }>,
): Promise<ApproveFacts> {
  const facts: ApproveFacts = {
    rows: new Map(),
    rowsByVariation: new Map(),
    staticNewest: new Map(),
    variations: new Map(),
    newerCapture: new Set(),
  };
  if (approves.length === 0) return facts;

  // The rows the approves wrote, as they are now.
  const rowIds = [...new Set(approves.map((a) => a.restore.baseline.id))];
  const rows = await db
    .select({
      id: baselines.id,
      variationId: baselines.testVariationId,
      runId: baselines.testRunId,
      branch: baselines.branchName,
      micros: epochMicros(baselines.createdAt),
    })
    .from(baselines)
    .where(inArray(baselines.id, rowIds));
  for (const r of rows) {
    const state: BaselineState = { ...r, micros: BigInt(r.micros) };
    facts.rows.set(r.id, state);
    const list = facts.rowsByVariation.get(r.variationId) ?? [];
    list.push(state);
    facts.rowsByVariation.set(r.variationId, list);
  }

  // Newest other row per (variation, branch), "current" ordering (ADR-068).
  if (rows.length > 0) {
    const others = await db
      .selectDistinctOn([baselines.testVariationId, baselines.branchName], {
        id: baselines.id,
        variationId: baselines.testVariationId,
        runId: baselines.testRunId,
        branch: baselines.branchName,
        micros: epochMicros(baselines.createdAt),
      })
      .from(baselines)
      .where(
        and(
          inArray(baselines.testVariationId, [
            ...new Set(rows.map((r) => r.variationId)),
          ]),
          notInArray(baselines.id, rowIds),
        ),
      )
      .orderBy(
        baselines.testVariationId,
        baselines.branchName,
        desc(baselines.createdAt),
        desc(baselines.id),
      );
    for (const r of others) {
      facts.staticNewest.set(pairKey(r.variationId, r.branch), {
        ...r,
        micros: BigInt(r.micros),
      });
    }
  }

  // Siblings: the same ADR-054 identity in the same project, on any branch
  // (the decided variation is its own sibling).
  const variationIds = [
    ...new Set(approves.map((a) => a.restore.variation.id)),
  ];
  const decided = await db
    .select({
      id: testVariations.id,
      projectId: testVariations.projectId,
      name: testVariations.name,
      viewport: testVariations.viewport,
      browser: testVariations.browser,
      os: testVariations.os,
      device: testVariations.device,
      // What the edit check (R25) compares against.
      baselineName: testVariations.baselineName,
      matchLevel: testVariations.matchLevel,
      ignoreRegions: testVariations.ignoreRegions,
      layoutRegions: testVariations.layoutRegions,
      floatingRegions: testVariations.floatingRegions,
      contentRegions: testVariations.contentRegions,
      accessibilityRegions: testVariations.accessibilityRegions,
    })
    .from(testVariations)
    .where(inArray(testVariations.id, variationIds));
  if (decided.length === 0) return facts;
  const identities = new Map<string, Identity>();
  for (const v of decided) {
    facts.variations.set(v.id, fieldsOf(v));
    identities.set(identityKey(v), v);
  }
  // The database narrows by project and name; the exact ADR-054 identity is
  // matched here. One `IN` each keeps the statement cheap however many
  // identities there are: an OR of five-column matches per identity costs the
  // client far more to build and bind than the database does to run (about
  // 25 ms of the 500-decision case).
  const siblingRows = (
    await db
      .select({
        id: testVariations.id,
        projectId: testVariations.projectId,
        name: testVariations.name,
        viewport: testVariations.viewport,
        browser: testVariations.browser,
        os: testVariations.os,
        device: testVariations.device,
      })
      .from(testVariations)
      .where(
        and(
          inArray(testVariations.projectId, [
            ...new Set(decided.map((v) => v.projectId)),
          ]),
          inArray(testVariations.name, [
            ...new Set(decided.map((v) => v.name)),
          ]),
        ),
      )
  ).filter((v) => identities.has(identityKey(v)));
  const siblingsByIdentity = new Map<string, Set<string>>();
  for (const s of siblingRows) {
    const key = identityKey(s);
    const set = siblingsByIdentity.get(key) ?? new Set<string>();
    set.add(s.id);
    siblingsByIdentity.set(key, set);
  }
  const siblingsOf = new Map<string, Set<string>>(
    decided.map((v) => [
      v.id,
      siblingsByIdentity.get(identityKey(v)) ?? new Set([v.id]),
    ]),
  );

  // Captures in another run made after the decision, or re-diffed after it
  // (R24: diffed while this approve's baseline was current). µs, in SQL.
  const candidates = approves.filter((a) =>
    facts.variations.has(a.restore.variation.id),
  );
  const newer =
    candidates.length === 0
      ? []
      : await db
          .selectDistinct({
            decisionId: checkpointDecisions.id,
            variationId: screenshots.testVariationId,
          })
          .from(checkpointDecisions)
          .innerJoin(
            screenshots,
            and(
              inArray(screenshots.testVariationId, [
                ...new Set(siblingRows.map((s) => s.id)),
              ]),
              ne(screenshots.runId, checkpointDecisions.runId),
              or(
                gt(screenshots.createdAt, checkpointDecisions.createdAt),
                gt(screenshots.verdictAt, checkpointDecisions.createdAt),
              ),
            ),
          )
          .where(
            inArray(
              checkpointDecisions.id,
              candidates.map((a) => a.d.id),
            ),
          );
  const variationOf = new Map(
    candidates.map((a) => [a.d.id, a.restore.variation.id]),
  );
  for (const r of newer) {
    const decidedVariation = variationOf.get(r.decisionId);
    if (
      decidedVariation !== undefined &&
      siblingsOf.get(decidedVariation)?.has(r.variationId)
    ) {
      facts.newerCapture.add(r.decisionId);
    }
  }
  return facts;
}

/** One action's undo as simulated so far: what its later decisions put back. */
interface Simulated {
  /** A baseline row now: deleted (null), restored to `prev`, or as stored. */
  baseline(row: BaselineState): BaselineState | null;
  /** A variation's fields now: restored to a snapshot, or as stored. */
  variation(id: string): VariationFields | undefined;
}

/**
 * Judges `decisions` — whole actions, in the order they were written
 * (`created_at, id`) — as an undo of each action would meet them: newest
 * first, each one judged with that action's later undoable decisions already
 * undone (a later approve of the same variation would otherwise always
 * "supersede" an earlier one, or look like an edit of it). Reads only.
 */
async function judgeActions(
  db: DB | Tx,
  decisions: ReadonlyArray<CheckpointDecisionRow>,
): Promise<Map<string, RevertSkipReason | null>> {
  const classified = new Map(decisions.map((d) => [d.id, classify(d)]));
  const approves = decisions.flatMap((d) => {
    const c = classified.get(d.id)!;
    return c.kind === "approve" ? [{ d, restore: c.restore }] : [];
  });
  const facts = await loadApproveFacts(db, approves);

  const byAction = new Map<string, CheckpointDecisionRow[]>();
  for (const d of decisions) {
    const list = byAction.get(actionKey(d)) ?? [];
    list.push(d);
    byAction.set(actionKey(d), list);
  }

  const out = new Map<string, RevertSkipReason | null>();
  for (const action of byAction.values()) {
    // This action's simulated undo, on top of the stored state.
    const rows = new Map<string, BaselineState | null>();
    const variations = new Map<string, VariationFields>();
    const sim: Simulated = {
      baseline: (row) => {
        const simulated = rows.get(row.id);
        return simulated === undefined ? row : simulated;
      },
      variation: (id) => variations.get(id) ?? facts.variations.get(id),
    };
    for (const d of [...action].reverse()) {
      const c = classified.get(d.id)!;
      if (c.kind !== "approve") {
        out.set(d.id, c.kind === "skip" ? c.reason : null);
        continue;
      }
      const reason = judgeApprove(d, c.restore, facts, sim);
      out.set(d.id, reason);
      if (reason !== null) continue;
      const { baseline: b, variation: v } = c.restore;
      const row = facts.rows.get(b.id)!;
      rows.set(
        row.id,
        b.op === "inserted"
          ? null
          : { ...row, branch: b.prev.branchName, micros: b.prevCreatedMicros },
      );
      variations.set(v.id, fieldsOf(v));
    }
  }
  return out;
}

/** The spec §5.3 approve checks, in table order. */
function judgeApprove(
  d: CheckpointDecisionRow,
  restore: ApproveRestore,
  facts: ApproveFacts,
  sim: Simulated,
): RevertSkipReason | null {
  const variationId = restore.variation.id;
  const row = facts.rows.get(restore.baseline.id);
  // The snapshot must name this checkpoint's own (variation, run) row and an
  // existing variation; anything else is not ours to delete or rewrite.
  if (
    !facts.variations.has(variationId) ||
    (row && (row.variationId !== variationId || row.runId !== d.runId))
  ) {
    return "history_corrupt";
  }
  if (facts.newerCapture.has(d.id)) return "superseded_newer_capture";
  // The newest-baseline check is judged on the row's own branch, so a row
  // that is gone can only be history_expired.
  const current = row ? sim.baseline(row) : null;
  if (!current) return "history_expired";
  const rival = facts.staticNewest.get(pairKey(variationId, current.branch));
  if (rival && isNewer(rival, current)) return "superseded_newer_baseline";
  for (const other of facts.rowsByVariation.get(variationId) ?? []) {
    if (other.id === current.id) continue;
    const s = sim.baseline(other);
    if (s && s.branch === current.branch && isNewer(s, current)) {
      return "superseded_newer_baseline";
    }
  }
  // R25: the variation must still be exactly what this approve wrote, or the
  // undo would silently wipe a later edit (a reviewer's regions, say).
  if (
    restore.variationAfter &&
    !sameFields(sim.variation(variationId)!, restore.variationAfter)
  ) {
    return "superseded_variation_edit";
  }
  return null;
}

/**
 * Whether each decision can be undone (null) or why not (spec §5.3), keyed by
 * decision id. Batched: a fixed number of queries however many decisions.
 *
 * Each decision is judged as part of its whole action, which is what an undo
 * reverts: the rest of the action is loaded too, and its decisions are undone
 * newest first, so a decision whose only "newer baseline" is a later approve
 * in the same action stays undoable. The decisions are re-read, so the
 * answer reflects the database, not the rows passed in (only their identity,
 * project and action are used); a decision that no longer exists (retention)
 * has no entry.
 *
 * Reads only; it neither locks nor writes.
 */
export async function assessRevert(
  db: DB | Tx,
  decisions: ReadonlyArray<
    Pick<CheckpointDecisionRow, "id" | "projectId" | "actionId">
  >,
): Promise<Map<string, RevertSkipReason | null>> {
  const out = new Map<string, RevertSkipReason | null>();
  if (decisions.length === 0) return out;
  const actions = new Set(decisions.map(actionKey));
  const universe = (
    await db
      .select()
      .from(checkpointDecisions)
      .where(
        inArray(checkpointDecisions.actionId, [
          ...new Set(decisions.map((d) => d.actionId)),
        ]),
      )
      .orderBy(asc(checkpointDecisions.createdAt), asc(checkpointDecisions.id))
  ).filter((d) => actions.has(actionKey(d)));
  const judged = await judgeActions(db, universe);
  for (const d of decisions) {
    const reason = judged.get(d.id);
    if (reason !== undefined) out.set(d.id, reason);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** An action's decisions in a project (or any project), in write order. */
function loadAction(
  tx: Tx,
  actionId: string,
  projectId: string | undefined,
): Promise<CheckpointDecisionRow[]> {
  return tx
    .select()
    .from(checkpointDecisions)
    .where(
      and(
        eq(checkpointDecisions.actionId, actionId),
        projectId === undefined
          ? undefined
          : eq(checkpointDecisions.projectId, projectId),
      ),
    )
    .orderBy(asc(checkpointDecisions.createdAt), asc(checkpointDecisions.id));
}

/**
 * Only the decider undoes their own action, or an admin (owner included).
 * A legacy decision with no actor never authorises a non-admin.
 */
function authorise(
  actor: AuthedUser,
  decisions: ReadonlyArray<CheckpointDecisionRow>,
): void {
  if (isAtLeastAdmin(actor.role)) return;
  if (decisions.every((d) => d.actorId === actor.id)) return;
  throw reviewError("FORBIDDEN", "not_decider");
}

/** Puts one approve's baseline row and variation back as its snapshot recorded them. */
async function restoreApprove(
  sp: Tx,
  d: CheckpointDecisionRow,
  { baseline, variation }: ApproveRestore,
): Promise<void> {
  if (baseline.op === "inserted") {
    await sp
      .delete(baselines)
      .where(
        and(
          eq(baselines.id, baseline.id),
          eq(baselines.testVariationId, variation.id),
          eq(baselines.testRunId, d.runId),
        ),
      );
  } else {
    const { prev } = baseline;
    await sp
      .update(baselines)
      .set({
        baselineName: prev.baselineName,
        // A user deleted since the snapshot reads as NULL, as `set null` would have left it.
        userId:
          prev.userId === null
            ? null
            : sql`(SELECT u.id FROM users u WHERE u.id = ${prev.userId}::uuid)`,
        branchName: prev.branchName,
        // µs-exact: the ISO text goes straight to Postgres. A JS Date would
        // truncate to ms and could reorder "current" baselines (ADR-068).
        createdAt: sql`${prev.createdAt}::timestamptz`,
        updatedAt: sql`${prev.updatedAt}::timestamptz`,
      })
      .where(eq(baselines.id, baseline.id));
  }
  await sp
    .update(testVariations)
    .set({
      baselineName: variation.baselineName,
      matchLevel: variation.matchLevel,
      ignoreRegions: variation.ignoreRegions,
      layoutRegions: variation.layoutRegions,
      floatingRegions: variation.floatingRegions,
      contentRegions: variation.contentRegions,
      accessibilityRegions: variation.accessibilityRegions,
      updatedAt: new Date(),
    })
    .where(eq(testVariations.id, variation.id));
}

/**
 * Undoes review action `input.actionId` inside the caller's transaction
 * (spec §5.3).
 *
 * 1. Loads the action; unknown (in `input.projectId`, when given) →
 *    `NOT_FOUND action_not_found`. Authorises before any lock or write: every
 *    decision must be the actor's, unless the actor is an admin or owner →
 *    otherwise `FORBIDDEN not_decider`. Only then, with no `projectId` given,
 *    an action found in two projects is refused as `BAD_REQUEST
 *    action_spans_projects`.
 * 2. Locks the action's runs, then the variations its approves would restore,
 *    both `FOR NO KEY UPDATE` in ascending id order (R8, as the decision core
 *    does), and re-reads the action under those locks (a concurrent undo has
 *    committed by then, so a retry finds `already_undone`). Decisions whose run
 *    retention has deleted are simply gone.
 * 3. Assesses every decision (`assessRevert`'s rules), finds the approved
 *    checkpoints re-diffed since their approve and the runs to re-diff (see
 *    `RevertResult.rediffRunIds`), all before the first write.
 * 4. In one savepoint (R16), newest decision first: restores each undoable
 *    approve's baseline row (delete an inserted row; rewrite an updated one to
 *    `prev`, timestamps µs-exact) and variation, clears the verdict of a
 *    checkpoint re-diffed since, stamps `reverted_at`/`reverted_by` on every
 *    undoable decision (a reject needs nothing else), and recomputes each run.
 * 5. Writes one `run.revert_action` audit row (none for a pure no-op: every
 *    decision already undone, R26), counts the outcomes and logs.
 *
 * Skipped decisions are reported, not fatal. Enqueueing `rediffRunIds` and
 * broadcasting are the caller's job, after commit.
 *
 * Known limitation (R29): a new capture of the same variation that commits
 * while an undo runs is not seen by the assessment (a capture takes neither
 * the run nor the variation locks), so its diff may be computed against the
 * baseline being undone. This is accepted; the next capture of the variation
 * is diffed against the restored baseline and corrects it.
 */
export async function revertAction(
  tx: Tx,
  input: RevertInput,
  deps: RevertDeps,
): Promise<RevertResult> {
  const { actor, actionId } = input;
  if (
    !UUID.test(actionId) ||
    (input.projectId !== undefined && !UUID.test(input.projectId))
  ) {
    throw reviewError("NOT_FOUND", "action_not_found");
  }

  // 1. Authorise on the action as recorded, before any lock or write.
  const recorded = await loadAction(tx, actionId, input.projectId);
  if (recorded.length === 0) {
    throw reviewError("NOT_FOUND", "action_not_found");
  }
  authorise(actor, recorded);
  const projectId = recorded[0]!.projectId;
  if (recorded.some((d) => d.projectId !== projectId)) {
    // The same client-generated id in two projects: two different actions.
    // Said only to a caller already authorised for all of it, so a stranger
    // cannot learn that an action exists in another project.
    throw reviewError("BAD_REQUEST", "action_spans_projects");
  }

  // 2. Locks (R8), then the action as it is under them.
  const runs = await lockRuns(
    tx,
    projectId,
    [...new Set(recorded.map((d) => d.runId))].sort(),
  );
  const decisions = (await loadAction(tx, actionId, projectId)).filter((d) =>
    runs.has(d.runId),
  );
  if (decisions.length === 0) {
    throw reviewError("NOT_FOUND", "action_not_found");
  }
  authorise(actor, decisions);
  const runIds = [...new Set(decisions.map((d) => d.runId))].sort();
  const classified = new Map(decisions.map((d) => [d.id, classify(d)]));
  const restoreOf = (d: CheckpointDecisionRow): ApproveRestore | null => {
    const c = classified.get(d.id)!;
    return c.kind === "approve" ? c.restore : null;
  };
  await lockVariations(
    tx,
    [
      ...new Set(
        decisions.flatMap((d) => {
          const r = restoreOf(d);
          return r ? [r.variation.id] : [];
        }),
      ),
    ].sort(),
  );

  // 3. Assessment, before the first write.
  const verdicts = await judgeActions(tx, decisions);
  const undoable = decisions.filter((d) => verdicts.get(d.id) === null);
  const skipped = decisions.flatMap((d) => {
    const reason = verdicts.get(d.id);
    return reason ? [{ checkpointId: d.screenshotId, reason }] : [];
  });
  const undoableApproves = undoable.filter((d) => restoreOf(d) !== null);
  // Re-diffed since the approve: that verdict was computed against the
  // baseline being undone, so it is cleared now. Compared in SQL, at µs
  // precision.
  const rediffed =
    undoableApproves.length === 0
      ? new Set<string>()
      : new Set(
          (
            await tx
              .select({ id: checkpointDecisions.id })
              .from(checkpointDecisions)
              .innerJoin(
                screenshots,
                eq(screenshots.id, checkpointDecisions.screenshotId),
              )
              .where(
                and(
                  inArray(
                    checkpointDecisions.id,
                    undoableApproves.map((d) => d.id),
                  ),
                  gt(screenshots.verdictAt, checkpointDecisions.createdAt),
                ),
              )
          ).map((r) => r.id),
        );
  // Every run with an approve undone is re-diffed after commit (R28): a diff
  // job already in flight may yet write a verdict against the undone baseline.
  //
  // So is a run whose approve was undone by an earlier call while a checkpoint
  // of it still has no verdict (R30): that call's enqueue, after its commit,
  // may have been lost, and without this a retry (all `already_undone`) would
  // never queue it again. A diff that has since landed leaves no NULL verdict.
  const undoneEarlier = [
    ...new Set(
      decisions
        .filter((d) => d.revertedAt !== null && d.decision === "approved")
        .map((d) => d.runId),
    ),
  ];
  const waitingForDiff =
    undoneEarlier.length === 0
      ? []
      : (
          await tx
            .selectDistinct({ runId: screenshots.runId })
            .from(screenshots)
            .where(
              and(
                inArray(screenshots.runId, undoneEarlier),
                isNull(screenshots.verdict),
              ),
            )
        ).map((r) => r.runId);
  const rediffRunIds = [
    ...new Set([...undoableApproves.map((d) => d.runId), ...waitingForDiff]),
  ].sort();

  // 4. The writes, atomic on their own (R16), newest decision first.
  const statuses = await tx.transaction(async (sp) => {
    for (const d of [...undoable].reverse()) {
      const restore = restoreOf(d);
      if (!restore) continue;
      await restoreApprove(sp, d, restore);
      if (rediffed.has(d.id)) {
        await sp
          .update(screenshots)
          .set({ verdict: null, verdictAt: null })
          .where(eq(screenshots.id, d.screenshotId));
      }
    }
    const ids = undoable.map((d) => d.id);
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      const chunk = ids.slice(i, i + UPDATE_CHUNK);
      const stamped = await sp
        .update(checkpointDecisions)
        .set({ revertedAt: sql`clock_timestamp()`, revertedBy: actor.id })
        .where(
          and(
            inArray(checkpointDecisions.id, chunk),
            isNull(checkpointDecisions.revertedAt),
          ),
        )
        .returning({ id: checkpointDecisions.id });
      // The run locks serialise undos, so this can't happen; if it does,
      // undo nothing rather than leave a restore without its stamp.
      if (stamped.length !== chunk.length) {
        throw new Error(`revert_raced:${actionId}`);
      }
    }
    const out: RevertResult["runs"] = [];
    for (const runId of runIds) {
      const { after } = await recomputeRunStatus(sp, runId);
      out.push({ runId, status: after });
    }
    return out;
  });

  // 5. Audit, metrics, log. A pure no-op (a retry: every decision already
  // undone) leaves no audit row (R26); any other outcome, refusals included,
  // is audited.
  const noOp =
    undoable.length === 0 &&
    skipped.every((x) => x.reason === "already_undone");
  const buildIds = new Set(runIds.map((id) => runs.get(id)!.buildId));
  if (!noOp) {
    await emitAudit(
      tx,
      {
        actorId: actor.id,
        action: "run.revert_action",
        ...(runIds.length === 1
          ? { targetType: "run", targetId: runIds[0]! }
          : {
              targetType: "build",
              // The shared build, else the first run's.
              targetId:
                buildIds.size === 1
                  ? [...buildIds][0]!
                  : runs.get(runIds[0]!)!.buildId,
            }),
        metadata: { actionId, reverted: undoable.length, skipped, runIds },
      },
      deps.logger,
    );
  }
  recordReviewRevert(deps.registry, "reverted", undoable.length);
  recordReviewRevert(deps.registry, "skipped", skipped.length);
  for (const s of skipped) recordReviewRevertRefused(deps.registry, s.reason);
  deps.logger.info(
    {
      project_id: projectId,
      // T2: a single-run action carries the `run_id` tag.
      ...(runIds.length === 1 ? { run_id: runIds[0] } : { run_ids: runIds }),
      actor_id: actor.id,
      action_id: actionId,
      reverted: undoable.length,
      skipped: skipped.length,
      rediff: rediffRunIds.length,
    },
    "review_reverted",
  );

  return {
    actionId,
    reverted: undoable.length,
    skipped,
    rediffRunIds,
    runs: statuses,
  };
}
