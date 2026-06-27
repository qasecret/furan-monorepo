package io.furan.sdk

import io.furan.sdk.dto.LoupeTestResults
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
 * Tests for [LoupeRunner] — verifying that runner.record() is called by
 * Loupe.close() and that getAllTestResults() aggregates correctly.
 *
 * Test seam: uses [FuranCapture]'s internal constructor + [FuranCapture.injectRunId]
 * to simulate a closed run without network calls (same pattern as
 * [FuranCaptureCloseTest] and [SaveNewTestsTest]).
 */
class LoupeRunnerTest {

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
    // Fix #5: LoupeRunner.record() is called from Loupe.close()
    // -------------------------------------------------------------------------

    /**
     * Validates the LoupeRunner contract directly: record() + getAllTestResults()
     * roundtrip. This test does NOT involve the Loupe facade (it is in core).
     */
    @Test
    fun `LoupeRunner record and getAllTestResults roundtrip`() {
        val runner = LoupeRunner()
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
    fun `LoupeRunner getAllTestResults throwException=true throws FuranSuiteException when any run failed`() {
        val runner = LoupeRunner()
        runner.record(RunResult(runId = "r1", status = RunStatus.PASSED, checkpointCount = 1))
        runner.record(RunResult(runId = "r2", status = RunStatus.UNRESOLVED, checkpointCount = 1))

        assertThrows<FuranSuiteException> {
            runner.getAllTestResults(throwException = true)
        }
    }

    @Test
    fun `LoupeRunner getAllTestResults throwException=true does NOT throw when all passed`() {
        val runner = LoupeRunner()
        runner.record(RunResult(runId = "r1", status = RunStatus.PASSED, checkpointCount = 1))

        val results = runner.getAllTestResults(throwException = true)
        assertEquals(1, results.size)
        assertTrue(results[0].isPassed)
    }

    @Test
    fun `LoupeRunner returns empty list when no runs recorded`() {
        val runner = LoupeRunner()
        val results = runner.getAllTestResults(throwException = false)
        assertTrue(results.isEmpty())
    }

    /**
     * Validates that FuranCapture.close() returns a RunResult (so Loupe.close()
     * can call runner.record()). The Loupe facade delegation is tested in each
     * adapter's LoupeDelegationTest; here we verify the FuranCapture seam.
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
     * End-to-end simulation of the LoupeRunner wiring:
     * 1. Runner is created.
     * 2. A FuranCapture stub simulates a closed run with UNRESOLVED status.
     * 3. The result is manually recorded on the runner (simulating Loupe.close()).
     * 4. getAllTestResults() contains it; throwException=true throws FuranSuiteException.
     *
     * Note: this test cannot instantiate selenium/playwright/appium Loupe directly
     * (wrong module), but it exercises the exact code path that Loupe.close() uses:
     * capture.close() → runner.record(rr) → LoupeTestResults(rr).
     */
    @Test
    fun `Loupe close wiring simulation — failing run recorded and throws on getAllTestResults`() {
        val runner = LoupeRunner()
        val rr = RunResult(runId = "r-sim", status = RunStatus.UNRESOLVED, checkpointCount = 3)

        // Simulate what Loupe.close() does:
        val capture = captureWith(rr, failOnDiff = FailOnDiff.None)
        val closed = capture.close() ?: error("close() returned null unexpectedly")
        runner.record(closed)
        val loupeResult = LoupeTestResults(closed)

        // Verify the LoupeTestResults wrapper
        assertFalse(loupeResult.isPassed)
        assertTrue(loupeResult.isDifferent)
        assertFalse(loupeResult.isAborted)

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
