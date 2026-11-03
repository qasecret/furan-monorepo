package io.furan.sdk

import io.furan.sdk.dto.RunStatus
import io.furan.sdk.dto.SnapshotResult
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * [endRunAfterFailure] decides how `use { }` and the JUnit 5 extension end a
 * run whose test threw. A verdict from `snapshotAndAwait` must leave the run
 * reviewable (completed); anything else aborts it.
 */
class RunEndTest {

    private fun result(status: RunStatus) =
        SnapshotResult(runId = "run-1", buildId = "build-1", status = status)

    private fun end(error: Throwable): List<String> {
        val calls = mutableListOf<String>()
        endRunAfterFailure(error, close = { calls += "close" }, abort = { calls += "abort" })
        return calls
    }

    @Test
    fun `a regression verdict completes the run instead of aborting it`() {
        assertEquals(listOf("close"), end(FuranAssertionException(result(RunStatus.UNRESOLVED))))
    }

    @Test
    fun `a no-baseline verdict completes the run so its first capture can be saved`() {
        assertEquals(listOf("close"), end(FuranNoBaselineException(result(RunStatus.NEW))))
    }

    @Test
    fun `an error that is not a verdict aborts the run`() {
        assertEquals(listOf("abort"), end(IllegalStateException("driver crashed")))
        assertEquals(listOf("abort"), end(FuranTimeoutException("run-1", RunStatus.RUNNING, 60)))
    }

    @Test
    fun `a failing close or abort never replaces the test's own error`() {
        endRunAfterFailure(
            FuranAssertionException(result(RunStatus.UNRESOLVED)),
            close = { throw FuranDiffException(io.furan.sdk.dto.RunResult("run-1", RunStatus.UNRESOLVED, 1)) },
            abort = { error("not called") },
        )
        endRunAfterFailure(
            IllegalStateException("driver crashed"),
            close = { error("not called") },
            abort = { throw IllegalStateException("network down") },
        )
    }
}
