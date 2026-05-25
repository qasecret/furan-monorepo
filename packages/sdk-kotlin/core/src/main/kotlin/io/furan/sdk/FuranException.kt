package io.furan.sdk

import io.furan.sdk.dto.SnapshotResult

/**
 * Base type for all SDK-raised exceptions. Catchers wanting "anything
 * the SDK can throw" should catch this; specific handlers catch a
 * subclass:
 *
 * ```
 * try {
 *     val result = furan.snapshotAndAwait("checkout")
 * } catch (e: FuranAssertionException) {
 *     log.warn("Visual regression: ${e.result.diffViewerUrl}")
 *     throw e   // propagate to fail the test
 * } catch (e: FuranTimeoutException) {
 *     log.warn("Diff worker slow; retrying once")
 *     // ...
 * } catch (e: FuranTransportException) {
 *     // 4xx/5xx after retries — server is unhealthy
 *     fail("Furan API unreachable: ${e.message}")
 * } catch (e: FuranConfigException) {
 *     // Caller setup error — env var missing, validation failed
 *     fail("Bad SDK config: ${e.message}")
 * }
 * ```
 *
 * Not a `sealed` class — keeping it open lets the transport-layer
 * exceptions in `io.furan.sdk.transport` extend it across the package
 * boundary without forcing the whole hierarchy into one file. The
 * sub-classes still form a closed set in practice (audited by
 * tests/FuranExceptionHierarchyTest.kt).
 */
abstract class FuranException(message: String, cause: Throwable? = null) :
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

/**
 * Raised when the SDK can't be initialized because of caller-supplied
 * configuration — missing env var, invalid value, validation failure
 * on the [FuranConfig] init block. Distinct from
 * [FuranTransportException] so a test author can react to "I forgot
 * to set FURAN_API_URL" (fix the env) differently from "the server
 * is down" (retry).
 *
 * Wraps the underlying [IllegalArgumentException] /
 * [IllegalStateException] thrown by [FuranConfig] validation so the
 * cause chain is preserved.
 */
class FuranConfigException(message: String, cause: Throwable? = null) :
    FuranException(message, cause)

/**
 * Raised when an HTTP request fails after the retry policy is
 * exhausted, OR when a 4xx response comes back from the server.
 * Wraps the transport's lower-level exception classes so any HTTP
 * error reaches user code as a single typed branch.
 *
 * Use [statusCode] to discriminate:
 *  - 401/403 → bad token / RBAC fail (fix [FuranConfig.apiToken])
 *  - 404 → resource not found (fix [FuranConfig.projectId] /
 *    `buildId`)
 *  - 4xx other → client bug (malformed payload, etc.)
 *  - 5xx / null → server unhealthy (transient — safe to retry once
 *    in test infra)
 */
open class FuranTransportException(
    /** HTTP status code, or null when the failure was pre-flight (no response). */
    val statusCode: Int?,
    /** Raw response body if available, often a JSON error envelope. */
    val responseBody: String?,
    message: String,
    cause: Throwable? = null,
) : FuranException(message, cause) {
    val isClientError: Boolean
        get() = statusCode in 400..499

    val isServerError: Boolean
        get() = statusCode in 500..599 || statusCode == null
}
