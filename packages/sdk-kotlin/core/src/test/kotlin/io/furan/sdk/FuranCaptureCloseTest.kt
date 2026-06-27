package io.furan.sdk

import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Unit tests for [FuranCapture.close] focusing on the awaited-verdict behavior:
 *  - EMPTY status → warn+pass, no throw
 *  - AfterEach + non-passing terminal → throws [FuranDiffException]
 *  - None + non-passing terminal → returns result without throwing
 *
 * Test seam: [FuranCapture] exposes an `internal` constructor that accepts a
 * pre-built [FuranClient]; [injectRunId] pre-sets a synthetic open run so
 * [close] has a run to complete. [TerminalStubClient] overrides [completeRun]
 * to return a terminal result so [completeAndAwaitRun] takes the fast-path
 * (no polling) and returns the desired verdict.
 */
class FuranCaptureCloseTest {

    private fun testConfig(failOnDiff: FailOnDiff = FailOnDiff.None) = FuranConfig(
        apiUrl = "http://127.0.0.1:1",
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false,
        failOnDiff = failOnDiff,
    )

    /**
     * Stub that returns [terminalResult] from [completeRun] (which must be
     * terminal so that [FuranClient.completeAndAwaitRun] exits without polling).
     * All other network calls are blocked by the unreachable apiUrl.
     */
    private class TerminalStubClient(
        config: FuranConfig,
        private val terminalResult: RunResult,
    ) : FuranClient(config, adapter = "test") {
        override suspend fun completeRun(runId: String): RunResult = terminalResult
    }

    /** No-op SpecDriver reused from [FuranCaptureTest]. */
    private object NoopDriver : SpecDriver {
        override fun getDriverInfo() = DriverInfo()
        override fun takeScreenshot() = ByteArray(0)
        override fun executeScript(script: String, vararg args: Any?): Any? = null
        override fun setViewportSize(size: Size) {}
        override fun findElement(selector: Selector): SpecElement? = null
    }

    /**
     * Builds a [FuranCapture] with a [TerminalStubClient] injected via the
     * `internal` constructor, and pre-sets the run id so [close] has a run to
     * complete (bypasses the network path of [open]).
     */
    private fun captureWithStubbedClose(
        result: RunResult,
        failOnDiff: FailOnDiff,
    ): FuranCapture {
        val cfg = testConfig(failOnDiff)
        val stub = TerminalStubClient(cfg, result)
        return FuranCapture(cfg, NoopDriver, adapter = "test", client = stub).also { capture ->
            capture.injectRunId(result.runId)
        }
    }

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    @Test
    fun `AfterEach with UNRESOLVED result throws FuranDiffException`() {
        val result = RunResult(runId = "r-unresolved", status = RunStatus.UNRESOLVED, checkpointCount = 2)
        val capture = captureWithStubbedClose(result, FailOnDiff.AfterEach)

        val ex = assertThrows<FuranDiffException> { capture.close() }
        assertEquals(result, ex.runResult)
    }

    @Test
    fun `AfterEach with EMPTY result does NOT throw and returns RunResult with status EMPTY`() {
        val result = RunResult(runId = "r-empty", status = RunStatus.EMPTY, checkpointCount = 0)
        val capture = captureWithStubbedClose(result, FailOnDiff.AfterEach)

        val returned = capture.close()
        assertNotNull(returned)
        assertEquals(RunStatus.EMPTY, returned!!.status)
    }

    @Test
    fun `None failOnDiff with UNRESOLVED result returns RunResult without throwing`() {
        val result = RunResult(runId = "r-none", status = RunStatus.UNRESOLVED, checkpointCount = 3)
        val capture = captureWithStubbedClose(result, FailOnDiff.None)

        val returned = capture.close()
        assertNotNull(returned)
        assertEquals(RunStatus.UNRESOLVED, returned!!.status)
    }
}
