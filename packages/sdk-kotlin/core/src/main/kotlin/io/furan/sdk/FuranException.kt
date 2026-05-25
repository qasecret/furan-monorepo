package io.furan.sdk

import io.furan.sdk.dto.SnapshotResult

/**
 * Base type for all SDK-raised exceptions. Catchers wanting "anything
 * the SDK can throw" should catch this; specific handlers catch a
 * subclass.
 */
sealed class FuranException(message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)

/**
 * Raised by `snapshotAndAwait()` when a run lands in a failure terminal
 * status ([io.furan.sdk.dto.RunStatus.UNRESOLVED] /
 * [io.furan.sdk.dto.RunStatus.FAILED] /
 * [io.furan.sdk.dto.RunStatus.ABORTED]) AND
 * [FuranConfig.softAssert] is false (the default — matches the Java SDK).
 *
 * The caller can still inspect the underlying [result] via the field —
 * useful when the test author wants to log the diff URL even after a
 * thrown assertion.
 */
class FuranAssertionException(val result: SnapshotResult) :
    FuranException(buildMessage(result)) {

    private companion object {
        fun buildMessage(r: SnapshotResult): String {
            val diff = r.diffPercent?.let { " (diff %.2f%%)".format(it) } ?: ""
            val link = r.diffViewerUrl?.let { ". Review at $it" } ?: ""
            return "Run ${r.runId} ended with status=${r.status.wire}$diff$link"
        }
    }
}

/**
 * Raised by `snapshotAndAwait()` when no terminal status appears within
 * [FuranConfig.pollTimeoutSeconds]. Distinct from
 * [FuranAssertionException] so test infra can retry on timeout (a
 * transient backpressure issue) without retrying on a real assertion
 * failure.
 */
class FuranTimeoutException(
    val runId: String,
    val lastStatus: io.furan.sdk.dto.RunStatus?,
    val timeoutSeconds: Long,
) : FuranException(
    "Run $runId did not reach a terminal status within ${timeoutSeconds}s " +
        "(last seen: ${lastStatus?.wire ?: "unknown"}). " +
        "Increase config.pollTimeoutSeconds or check that the diff-worker is running.",
)
