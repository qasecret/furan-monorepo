package io.furan.sdk

import io.furan.sdk.dto.EyesTestResults
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Tests for [EyesRunner] — verifying that runner.record() is called by
 * Eyes.close() and that getAllTestResults() aggregates correctly.
 *
 * Test seam: uses [FuranCapture]'s internal constructor + [FuranCapture.injectRunId]
 * to simulate a closed run without network calls (same pattern as
 * [FuranCaptureCloseTest] and [SaveNewTestsTest]).
 */
class EyesRunnerTest {

    private fun testConfig(failOnDiff: FailOnDiff = FailOnDiff.None) = FuranConfig(
        apiUrl = "http://127.0.0.1:1",
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false,
        failOnDiff = failOnDiff,
    )

    /** No-op SpecDriver — capture engine is never exercised in these tests. */
    private object NoopDriver : SpecDriver {
        override fun getDriverInfo() = DriverInfo()
        override fun takeScreenshot() = ByteArray(0)
        override fun executeScript(script: String, vararg args: Any?): Any? = null
        override fun setViewportSize(size: Size) {}
        override fun findElement(selector: Selector): SpecElement? = null
    }

    /**
     * Stub client that returns [terminalResult] from [completeRun] so
     * [FuranCapture.completeAndAwaitRun] takes the fast-path (no polling).
     */
    private class TerminalStubClient(
        config: FuranConfig,
        private val terminalResult: RunResult,
    ) : FuranClient(config, adapter = "test") {
        override suspend fun completeRun(runId: String): RunResult = terminalResult
    }

    /**
     * Builds a [FuranCapture] with the given terminal result and injects a
     * synthetic runId — bypasses the open() network path.
     */
    private fun captureWith(result: RunResult, failOnDiff: FailOnDiff = FailOnDiff.None): FuranCapture {
        val cfg = testConfig(failOnDiff)
        return FuranCapture(cfg, NoopDriver, adapter = "test", client = TerminalStubClient(cfg, result))
            .also { it.injectRunId(result.runId) }
    }

    // -------------------------------------------------------------------------
    // Fix #5: EyesRunner.record() is called from Eyes.close()
    // -------------------------------------------------------------------------

    /**
     * Validates the EyesRunner contract directly: record() + getAllTestResults()
     * roundtrip. This test does NOT involve the Eyes facade (it is in core).
     */
    @Test
    fun `EyesRunner record and getAllTestResults roundtrip`() {
        val runner = EyesRunner()
        val rr1 = RunResult(runId = "r1", status = RunStatus.PASSED, checkpointCount = 1)
        val rr2 = RunResult(runId = "r2", status = RunStatus.UNRESOLVED, checkpointCount = 2)

        runner.record(rr1)
        runner.record(rr2)

        val results = runner.getAllTestResults(throwException = false)
        assertEquals(2, results.size)
        assertEquals("r1", results[0].runId)
        assertEquals(RunStatus.PASSED, results[0].status)
        assertEquals("r2", results[1].runId)
        assertEquals(RunStatus.UNRESOLVED, results[1].status)
    }

    @Test
    fun `EyesRunner getAllTestResults throwException=true throws FuranSuiteException when any run failed`() {
        val runner = EyesRunner()
        runner.record(RunResult(runId = "r1", status = RunStatus.PASSED, checkpointCount = 1))
        runner.record(RunResult(runId = "r2", status = RunStatus.UNRESOLVED, checkpointCount = 1))

        assertThrows<FuranSuiteException> {
            runner.getAllTestResults(throwException = true)
        }
    }

    @Test
    fun `EyesRunner getAllTestResults throwException=true does NOT throw when all passed`() {
        val runner = EyesRunner()
        runner.record(RunResult(runId = "r1", status = RunStatus.PASSED, checkpointCount = 1))

        val results = runner.getAllTestResults(throwException = true)
        assertEquals(1, results.size)
        assertTrue(results[0].isPassed)
    }

    @Test
    fun `EyesRunner returns empty list when no runs recorded`() {
        val runner = EyesRunner()
        val results = runner.getAllTestResults(throwException = false)
        assertTrue(results.isEmpty())
    }

    /**
     * Validates that FuranCapture.close() returns a RunResult (so Eyes.close()
     * can call runner.record()). The Eyes facade delegation is tested in each
     * adapter's EyesDelegationTest; here we verify the FuranCapture seam.
     */
    @Test
    fun `FuranCapture close returns RunResult for a failing run (UNRESOLVED, failOnDiff=None)`() {
        val rr = RunResult(runId = "r-fail", status = RunStatus.UNRESOLVED, checkpointCount = 1)
        val capture = captureWith(rr, failOnDiff = FailOnDiff.None)

        val result = capture.close()
        assertNotNull(result)
        assertEquals(RunStatus.UNRESOLVED, result!!.status)
        assertEquals("r-fail", result.runId)
    }

    @Test
    fun `FuranCapture close returns RunResult for a passing run (PASSED)`() {
        val rr = RunResult(runId = "r-pass", status = RunStatus.PASSED, checkpointCount = 2)
        val capture = captureWith(rr)

        val result = capture.close()
        assertNotNull(result)
        assertEquals(RunStatus.PASSED, result!!.status)
    }

    /**
     * End-to-end simulation of the EyesRunner wiring:
     * 1. Runner is created.
     * 2. A FuranCapture stub simulates a closed run with UNRESOLVED status.
     * 3. The result is manually recorded on the runner (simulating Eyes.close()).
     * 4. getAllTestResults() contains it; throwException=true throws FuranSuiteException.
     *
     * Note: this test cannot instantiate selenium/playwright/appium Eyes directly
     * (wrong module), but it exercises the exact code path that Eyes.close() uses:
     * capture.close() → runner.record(rr) → EyesTestResults(rr).
     */
    @Test
    fun `Eyes close wiring simulation — failing run recorded and throws on getAllTestResults`() {
        val runner = EyesRunner()
        val rr = RunResult(runId = "r-sim", status = RunStatus.UNRESOLVED, checkpointCount = 3)

        // Simulate what Eyes.close() does:
        val capture = captureWith(rr, failOnDiff = FailOnDiff.None)
        val closed = capture.close() ?: error("close() returned null unexpectedly")
        runner.record(closed)
        val eyesResult = EyesTestResults(closed)

        // Verify the EyesTestResults wrapper
        assertFalse(eyesResult.isPassed)
        assertTrue(eyesResult.isDifferent)
        assertFalse(eyesResult.isAborted)

        // Verify the runner accumulated the result
        val allResults = runner.getAllTestResults(throwException = false)
        assertEquals(1, allResults.size)
        assertFalse(allResults[0].isPassed)

        // throwException=true must throw FuranSuiteException
        assertThrows<FuranSuiteException> {
            runner.getAllTestResults(throwException = true)
        }
    }
}
