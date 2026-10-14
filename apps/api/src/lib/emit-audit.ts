import { auditLog, type DB, type Tx } from "@furan/db";

export interface AuditEvent {
  /** Who performed the action (a user id), or null for a system action. */
  actorId: string | null;
  /** Dotted verb, e.g. "user.created", "user.updated". */
  action: string;
  /** Kind of entity acted on, e.g. "user". */
  targetType: string;
  /** The affected entity's id. */
  targetId?: string | null;
  /** Free-form details — before/after, changed fields, etc. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Write one row to `audit_log`. Best-effort: a DB error is logged and swallowed
 * so an audit failure can never fail the audited mutation (the caller has
 * already performed the action). Trade-off: a rare write failure loses that
 * single record — but it is logged with the full event for reconstruction.
 *
 * The insert runs in its own savepoint. Callers pass the request-scoped
 * transaction (ADR-058) or a transaction of their own (a `Tx`), and a failed
 * statement aborts the whole transaction,
 * so catching the error alone would still roll back the audited action.
 * Rolling back to the savepoint keeps the caller's transaction usable; on a
 * non-transactional handle it is just a one-statement transaction.
 */
export async function emitAudit(
  db: DB | Tx,
  event: AuditEvent,
  logger: { error: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    await db.transaction(async (sp) => {
      await sp.insert(auditLog).values({
        actorId: event.actorId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId ?? null,
        metadata: event.metadata ?? null,
      });
    });
  } catch (err) {
    logger.error({ err, event }, "audit_emit_failed");
  }
}
