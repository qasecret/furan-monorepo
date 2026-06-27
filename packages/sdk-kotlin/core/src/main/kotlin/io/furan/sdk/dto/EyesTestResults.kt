package io.furan.sdk.dto

/**
 * Applitools `TestResults`-shaped read-only VIEW over the canonical
 * [RunResult]. No parallel model — accessors derive from the wrapped run.
 */
class EyesTestResults(val run: RunResult) {
    val runId: String get() = run.runId
    val status: RunStatus get() = run.status
    val checkpointCount: Int get() = run.checkpointCount
    val isPassed: Boolean get() = run.status == RunStatus.PASSED
    val isNew: Boolean get() = run.status == RunStatus.NEW
    val isDifferent: Boolean get() = run.status == RunStatus.UNRESOLVED || run.status == RunStatus.FAILED
    val isAborted: Boolean get() = run.status == RunStatus.ABORTED
    val isEmpty: Boolean get() = run.status == RunStatus.EMPTY
}
