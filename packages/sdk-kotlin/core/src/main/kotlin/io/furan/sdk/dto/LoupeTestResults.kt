package io.furan.sdk.dto

/**
 * A read-only VIEW over the canonical
 * [RunResult]. No parallel model — accessors derive from the wrapped run.
 *
 * Pass-gate guidance:
 * - [isPassed] is the strict pass gate — false for NEW, UNRESOLVED, FAILED,
 *   ABORTED, EMPTY, and RUNNING. Use this for CI pass/fail decisions.
 * - [isDifferent] specifically means visual diffs were detected
 *   (UNRESOLVED or FAILED) and intentionally excludes ABORTED; use
 *   [isAborted] to check for aborted runs separately.
 * - RUNNING is a non-terminal status and is not expected here — Loupe.close()
 *   blocks until the run reaches a terminal status before returning.
 */
class LoupeTestResults(val run: RunResult) {
    val runId: String get() = run.runId
    val status: RunStatus get() = run.status
    val checkpointCount: Int get() = run.checkpointCount
    val isPassed: Boolean get() = run.status == RunStatus.PASSED
    val isNew: Boolean get() = run.status == RunStatus.NEW
    val isDifferent: Boolean get() = run.status == RunStatus.UNRESOLVED || run.status == RunStatus.FAILED
    val isAborted: Boolean get() = run.status == RunStatus.ABORTED
    val isEmpty: Boolean get() = run.status == RunStatus.EMPTY
}
