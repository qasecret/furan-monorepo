package io.furan.sdk.dto

/**
 * The terminal outcome of a single `snapshotAndAwait()` call. Wraps the
 * server-side run row with the fields a test author cares about most:
 * the typed [status], the diff percent (if computed), whether the run
 * was auto-approved (first-baseline or pixel-identical), and a deep link
 * to the diff viewer for the CI log to print.
 *
 * Returned from `FuranClient.snapshotAndAwait()` on PASSED (always) and
 * on any failure terminal when `config.softAssert == true`. Otherwise
 * the client throws [io.furan.sdk.FuranAssertionException] carrying this
 * same result so the catcher can still inspect it.
 */
data class SnapshotResult(
    val runId: String,
    val buildId: String,
    val status: RunStatus,
    /** 0.0–100.0 once the diff worker has computed it; null mid-flight. */
    val diffPercent: Double? = null,
    val autoApproved: Boolean = false,
    val baselineSource: String? = null,
    /**
     * Deep link into the dashboard's diff viewer for this run. Composed
     * from `FuranConfig.dashboardUrl` when set; null if the SDK was not
     * told where the dashboard lives. Use it in CI logs:
     *
     *     log.info("Diff viewer: ${result.diffViewerUrl}")
     */
    val diffViewerUrl: String? = null,
) {
    /** True when status is [RunStatus.PASSED] — the test "succeeded" from the SDK's POV. */
    fun isPassed(): Boolean = status == RunStatus.PASSED

    /** Convenience for `result.status.isFailure()`. */
    fun isFailure(): Boolean = status.isFailure()
}
