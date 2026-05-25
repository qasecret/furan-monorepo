package io.furan.sdk.dto

import io.furan.sdk.FuranAssertionException
import io.furan.sdk.FuranTimeoutException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SnapshotResultTest {
    private fun result(
        status: RunStatus = RunStatus.PASSED,
        diffPercent: Double? = null,
        diffViewerUrl: String? = null,
    ) = SnapshotResult(
        runId = "r1",
        buildId = "b1",
        status = status,
        diffPercent = diffPercent,
        diffViewerUrl = diffViewerUrl,
    )

    @Test
    fun `isPassed and isFailure mirror the underlying status`() {
        assertTrue(result(RunStatus.PASSED).isPassed())
        assertFalse(result(RunStatus.PASSED).isFailure())
        assertFalse(result(RunStatus.UNRESOLVED).isPassed())
        assertTrue(result(RunStatus.UNRESOLVED).isFailure())
        assertFalse(result(RunStatus.RUNNING).isPassed())
        assertFalse(result(RunStatus.RUNNING).isFailure())
    }

    @Test
    fun `FuranAssertionException message includes the run id and status`() {
        val ex = FuranAssertionException(result(RunStatus.UNRESOLVED))
        // Lock in the format — CI consumers may grep these strings.
        val msg = ex.message ?: ""
        assertTrue(msg.contains("Run r1"), "missing run id: $msg")
        assertTrue(msg.contains("status=unresolved"), "missing status: $msg")
        // No diffPercent in this result → no `(diff ...)`. No dashboardUrl → no `Review at`.
        assertFalse(msg.contains("Review at"), "unexpected URL: $msg")
        assertFalse(msg.contains("diff "), "unexpected diff %: $msg")
    }

    @Test
    fun `FuranAssertionException message includes diff percent when present`() {
        val ex = FuranAssertionException(result(RunStatus.UNRESOLVED, diffPercent = 12.345))
        val msg = ex.message ?: ""
        assertTrue(msg.contains("diff 12.35%"), "missing/rounded diff %: $msg")
    }

    @Test
    fun `FuranAssertionException message includes the diff viewer URL when configured`() {
        val ex = FuranAssertionException(
            result(
                status = RunStatus.UNRESOLVED,
                diffViewerUrl = "http://localhost:3001/projects/p1/runs/r1/diffs/r1",
            ),
        )
        val msg = ex.message ?: ""
        assertTrue(
            msg.contains("Review at http://localhost:3001/projects/p1/runs/r1/diffs/r1"),
            "missing URL: $msg",
        )
    }

    @Test
    fun `FuranAssertionException exposes the result for post-throw inspection`() {
        // Catchers may want to log autoApproved / baselineSource even
        // on the throw path.
        val r = result(RunStatus.FAILED, diffPercent = 99.9)
        val ex = FuranAssertionException(r)
        assertEquals(r, ex.result)
        assertEquals(RunStatus.FAILED, ex.result.status)
    }

    @Test
    fun `FuranTimeoutException carries the runId and last seen status`() {
        val ex = FuranTimeoutException(
            runId = "r1",
            lastStatus = RunStatus.RUNNING,
            timeoutSeconds = 30,
        )
        val msg = ex.message ?: ""
        assertTrue(msg.contains("r1"), "missing runId: $msg")
        assertTrue(msg.contains("30s"), "missing timeout: $msg")
        assertTrue(msg.contains("running"), "missing last status: $msg")
    }

    @Test
    fun `FuranTimeoutException tolerates null lastStatus`() {
        // First poll iteration may throw RetriableException → outer loop
        // catches it → lastStatus stays null. The message must still be
        // useful.
        val ex = FuranTimeoutException(runId = "r2", lastStatus = null, timeoutSeconds = 60)
        val msg = ex.message ?: ""
        assertTrue(msg.contains("last seen: unknown"), msg)
        assertNull(ex.lastStatus)
    }
}
