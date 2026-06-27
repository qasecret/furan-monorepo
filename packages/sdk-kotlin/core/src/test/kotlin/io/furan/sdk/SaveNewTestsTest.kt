package io.furan.sdk

import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.spec.DriverInfo
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import io.furan.sdk.spec.SpecElement
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Behavior tests for the Eyes-scoped `saveNewTests` feature (phase-3 of close()).
 *
 * When `saveNewTests=true`, a terminal NEW result triggers:
 *   1. `approveRun(runId)` — client-side baseline seeding
 *   2. `getRun(runId)` — re-fetch to get the post-approval status
 *   3. Return the refreshed status (usually PASSED)
 *
 * If `approveRun` throws, close() propagates the exception (the run is NOT
 * reported as passed). If `saveNewTests=false`, no approve call is made
 * and the NEW status is returned as-is.
 */
class SaveNewTestsTest {

    private fun testConfig(saveNewTests: Boolean, failOnDiff: FailOnDiff = FailOnDiff.None) =
        FuranConfig(
            apiUrl = "http://127.0.0.1:1",
            apiToken = "furan_pat_test_abcdefghijklmnopqrst",
            projectId = "00000000-0000-0000-0000-000000000000",
            telemetryEnabled = false,
            saveNewTests = saveNewTests,
            failOnDiff = failOnDiff,
        )

    /** No-op SpecDriver — the capture engine is never exercised in these tests. */
    private object NoopDriver : SpecDriver {
        override fun getDriverInfo() = DriverInfo()
        override fun takeScreenshot() = ByteArray(0)
        override fun executeScript(script: String, vararg args: Any?): Any? = null
        override fun setViewportSize(size: Size) {}
        override fun findElement(selector: Selector): SpecElement? = null
    }

    /**
     * Configurable stub that overrides [completeRun], [approveRun], and [getRun]
     * without any network. Tracks call counts for assertions.
     */
    private class SaveNewTestsStubClient(
        config: FuranConfig,
        private val completeResult: RunResult,
        private val approveAction: () -> Unit = {},       // default: no-op (success)
        private val getRunResult: RunResponse? = null,    // null = not expected to be called
    ) : FuranClient(config, adapter = "test") {
        var approveCalls = 0
        var getRunCalls = 0

        override suspend fun completeRun(runId: String): RunResult = completeResult

        override suspend fun approveRun(runId: String) {
            approveCalls++
            approveAction()
        }

        override suspend fun getRun(runId: String): RunResponse {
            getRunCalls++
            return getRunResult
                ?: error("getRun called unexpectedly — stub has no getRunResult configured")
        }
    }

    /**
     * Builds a [FuranCapture] with a pre-configured stub client and
     * injects a synthetic runId so close() can operate without going
     * through the open() network path.
     */
    private fun makeCaptureWith(
        config: FuranConfig,
        completeResult: RunResult,
        approveAction: () -> Unit = {},
        getRunResult: RunResponse? = null,
    ): SaveNewTestsStubClient {
        return SaveNewTestsStubClient(config, completeResult, approveAction, getRunResult)
    }

    // -------------------------------------------------------------------------
    // Behavior 1: NEW + saveNewTests=true + approve succeeds → PASSED
    // -------------------------------------------------------------------------

    @Test
    fun `saveNewTests=true with NEW result approves and returns PASSED`() {
        val cfg = testConfig(saveNewTests = true)
        val completeResult = RunResult(runId = "r1", status = RunStatus.NEW, checkpointCount = 1)
        val getRunResponse = RunResponse(id = "r1", projectId = "proj", buildId = "b1", status = RunStatus.PASSED)
        val stub = makeCaptureWith(cfg, completeResult, getRunResult = getRunResponse)

        val capture = FuranCapture(cfg, NoopDriver, adapter = "test", client = stub)
        capture.injectRunId("r1")

        val result = capture.close()
        assertEquals(RunStatus.PASSED, result?.status)
        assertEquals(1, stub.approveCalls, "approveRun must be called exactly once")
        assertEquals(1, stub.getRunCalls, "getRun must be called exactly once after approve")
    }

    // -------------------------------------------------------------------------
    // Behavior 2: NEW + saveNewTests=true + approve THROWS → exception propagates
    // -------------------------------------------------------------------------

    @Test
    fun `saveNewTests=true with NEW result and failing approve propagates exception`() {
        val cfg = testConfig(saveNewTests = true)
        val completeResult = RunResult(runId = "r2", status = RunStatus.NEW, checkpointCount = 1)
        val stub = makeCaptureWith(
            cfg,
            completeResult,
            approveAction = { throw RuntimeException("network error on approve") },
            getRunResult = null, // getRun must NOT be called if approve throws
        )

        val capture = FuranCapture(cfg, NoopDriver, adapter = "test", client = stub)
        capture.injectRunId("r2")

        assertThrows<RuntimeException> { capture.close() }
        // Approve was attempted (and threw).
        assertEquals(1, stub.approveCalls)
        // getRun must NOT have been called — approve threw before we got there.
        assertEquals(0, stub.getRunCalls)
    }

    // -------------------------------------------------------------------------
    // Behavior 3: NEW + saveNewTests=false → returns NEW, no approve called
    // -------------------------------------------------------------------------

    @Test
    fun `saveNewTests=false with NEW result returns NEW without calling approveRun`() {
        // Use FailOnDiff.None so close() returns rather than throws on non-passing.
        val cfg = testConfig(saveNewTests = false, failOnDiff = FailOnDiff.None)
        val completeResult = RunResult(runId = "r3", status = RunStatus.NEW, checkpointCount = 1)
        val stub = makeCaptureWith(cfg, completeResult)

        val capture = FuranCapture(cfg, NoopDriver, adapter = "test", client = stub)
        capture.injectRunId("r3")

        val result = capture.close()
        assertEquals(RunStatus.NEW, result?.status)
        assertEquals(0, stub.approveCalls, "approveRun must NOT be called when saveNewTests=false")
        assertEquals(0, stub.getRunCalls, "getRun must NOT be called when saveNewTests=false")
    }

    // -------------------------------------------------------------------------
    // Behavior 4 (#3a): NEW + saveNewTests=true + approve succeeds, but the
    // post-approve getRun returns a NULL status → result must be UNRESOLVED,
    // NEVER fabricated PASSED. A null/unknown status is a "couldn't determine"
    // signal and must not read as a pass.
    // -------------------------------------------------------------------------

    @Test
    fun `saveNewTests=true with NEW result and null post-approve status returns UNRESOLVED not PASSED`() {
        // FailOnDiff.None so a non-passing status is returned rather than thrown.
        val cfg = testConfig(saveNewTests = true, failOnDiff = FailOnDiff.None)
        val completeResult = RunResult(runId = "r4", status = RunStatus.NEW, checkpointCount = 1)
        // getRun returns status = null (server hasn't settled, or unknown wire).
        val getRunResponse =
            RunResponse(id = "r4", projectId = "proj", buildId = "b1", status = null)
        val stub = makeCaptureWith(cfg, completeResult, getRunResult = getRunResponse)

        val capture = FuranCapture(cfg, NoopDriver, adapter = "test", client = stub)
        capture.injectRunId("r4")

        val result = capture.close()
        assertEquals(
            RunStatus.UNRESOLVED,
            result?.status,
            "null post-approve status must fall back to UNRESOLVED, not PASSED",
        )
        assertEquals(1, stub.approveCalls)
        assertEquals(1, stub.getRunCalls)
    }

    // -------------------------------------------------------------------------
    // Behavior 5 (#3b): NEW + saveNewTests=true + approve succeeds, but the
    // post-approve status is non-passing (UNRESOLVED) AND failOnDiff=AfterEach
    // → close() must throw FuranDiffException. The saveNewTests branch must not
    // bypass the FailOnDiff verdict.
    // -------------------------------------------------------------------------

    @Test
    fun `saveNewTests=true + AfterEach + non-passing post-approve status throws FuranDiffException`() {
        val cfg = testConfig(saveNewTests = true, failOnDiff = FailOnDiff.AfterEach)
        val completeResult = RunResult(runId = "r5", status = RunStatus.NEW, checkpointCount = 1)
        // Approve seeded a baseline, but the run is still unresolved.
        val getRunResponse =
            RunResponse(id = "r5", projectId = "proj", buildId = "b1", status = RunStatus.UNRESOLVED)
        val stub = makeCaptureWith(cfg, completeResult, getRunResult = getRunResponse)

        val capture = FuranCapture(cfg, NoopDriver, adapter = "test", client = stub)
        capture.injectRunId("r5")

        val ex = assertThrows<FuranDiffException> { capture.close() }
        // The exception carries the REFRESHED (post-approve) result.
        assertEquals("r5", ex.runResult.runId)
        assertEquals(RunStatus.UNRESOLVED, ex.runResult.status)
        // approve + getRun both happened before the verdict was applied.
        assertEquals(1, stub.approveCalls)
        assertEquals(1, stub.getRunCalls)
    }
}
