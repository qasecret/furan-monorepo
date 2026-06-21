package io.furan.sdk

import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.RunStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class FuranClientTest {
    private fun testConfig(dashboardUrl: String? = null) = FuranConfig(
        apiUrl = "http://127.0.0.1:1", // won't be hit (no actual post)
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false, // disable so close() doesn't try to POST
        dashboardUrl = dashboardUrl,
    )

    private fun runRow(
        status: RunStatus = RunStatus.PASSED,
        diffPercent: Double? = null,
        autoApproved: Boolean? = null,
        baselineSource: String? = null,
    ) = RunResponse(
        id = "run-uuid",
        projectId = "proj-uuid",
        buildId = "build-uuid",
        status = status,
        diffPercent = diffPercent,
        autoApproved = autoApproved,
        baselineSource = baselineSource,
    )

    @Test
    fun `constructs without error`() {
        val client = FuranClient(testConfig(), adapter = "test")
        client.close()
    }

    @Test
    fun `composeResult copies status, diff, autoApproved, baselineSource onto SnapshotResult`() {
        val client = FuranClient(testConfig(), adapter = "test")
        try {
            val run = runRow(
                status = RunStatus.PASSED,
                diffPercent = 0.5,
                autoApproved = true,
                baselineSource = "this_branch",
            )
            val r = client.composeResult(run, RunStatus.PASSED)
            assertEquals("run-uuid", r.runId)
            assertEquals("build-uuid", r.buildId)
            assertEquals(RunStatus.PASSED, r.status)
            assertEquals(0.5, r.diffPercent)
            assertTrue(r.autoApproved)
            assertEquals("this_branch", r.baselineSource)
        } finally {
            client.close()
        }
    }

    @Test
    fun `composeResult treats null autoApproved as false (default-safe)`() {
        // The server may omit autoApproved entirely for in-flight runs.
        // Result.autoApproved is a strict Boolean so user asserts read
        // cleanly — null defaults to false.
        val client = FuranClient(testConfig(), adapter = "test")
        try {
            val r = client.composeResult(runRow(autoApproved = null), RunStatus.UNRESOLVED)
            assertEquals(false, r.autoApproved)
        } finally {
            client.close()
        }
    }

    @Test
    fun `composeResult emits diffViewerUrl when dashboardUrl is configured`() {
        val client = FuranClient(
            testConfig(dashboardUrl = "http://localhost:3001"),
            adapter = "test",
        )
        try {
            val r = client.composeResult(runRow(), RunStatus.PASSED)
            assertEquals(
                "http://localhost:3001/projects/proj-uuid/runs/run-uuid/diffs/run-uuid",
                r.diffViewerUrl,
            )
        } finally {
            client.close()
        }
    }

    @Test
    fun `composeResult omits diffViewerUrl when dashboardUrl is null`() {
        val client = FuranClient(testConfig(dashboardUrl = null), adapter = "test")
        try {
            val r = client.composeResult(runRow(), RunStatus.PASSED)
            assertNull(r.diffViewerUrl)
        } finally {
            client.close()
        }
    }

    @Test
    fun `composeResult translates first-baseline (NEW + autoApproved=true) to PASSED`() {
        // Wire shape from the server for a first-baseline run: status
        // stays `new` permanently, but autoApproved flips true once the
        // diff worker has accepted it as the new baseline. From an SDK
        // consumer's POV that's a successful terminal — assertions need
        // to read `assertEquals(PASSED, result.status)` for both
        // "first baseline" AND "subsequent matching run".
        val client = FuranClient(testConfig(), adapter = "test")
        try {
            val run = runRow(status = RunStatus.NEW, autoApproved = true)
            val r = client.composeResult(run, RunStatus.NEW)
            assertEquals(RunStatus.PASSED, r.status)
            assertTrue(r.autoApproved)
            assertTrue(r.isPassed())
            assertFalse(r.isFailure())
        } finally {
            client.close()
        }
    }

    @Test
    fun `composeResult preserves NEW status when not auto-approved`() {
        // ADR-036: when a project has `autoApproveFeature = false`, the
        // first-baseline run lands as NEW with no auto-seeded baseline.
        // The polling loop NOW reaches this case as a real terminal
        // (isDone treats NEW as terminal regardless of autoApproved),
        // and composeResult must preserve the wire status — not coerce
        // to PASSED, since there's nothing to "pass" against yet.
        // Callers see NEW and either approve manually in the dashboard
        // (creates the baseline) or use softAssert=true to tolerate it.
        val client = FuranClient(testConfig(), adapter = "test")
        try {
            val run = runRow(status = RunStatus.NEW, autoApproved = null)
            val r = client.composeResult(run, RunStatus.NEW)
            assertEquals(RunStatus.NEW, r.status)
            assertEquals(false, r.autoApproved)
        } finally {
            client.close()
        }
    }

    // ADR-036 ergonomics (2026-06-21): a no-baseline first run (status=new,
    // not auto-approved) must fail loudly + actionably when softAssert is off,
    // instead of silently returning NEW for the caller's assertEquals to trip on.

    @Test
    fun `resolveOrThrow throws FuranNoBaselineException on no-baseline NEW (softAssert off)`() {
        val client = FuranClient(testConfig(), adapter = "test")
        try {
            // composeResult keeps NEW when autoApproved != true — the
            // no-baseline / needs-approval case.
            val newResult = client.composeResult(
                runRow(status = RunStatus.NEW, autoApproved = null),
                RunStatus.NEW,
            )
            assertEquals(RunStatus.NEW, newResult.status)
            val ex = assertThrows<FuranNoBaselineException> {
                client.resolveOrThrow(newResult)
            }
            // Self-documenting: the message names all three escape hatches.
            assertTrue(ex.message!!.contains("autoApproveFeature"))
            assertTrue(ex.message!!.contains("FURAN_SOFT_ASSERT"))
            assertTrue(ex.message!!.lowercase().contains("baseline"))
            assertEquals(newResult, ex.result)
        } finally {
            client.close()
        }
    }

    @Test
    fun `resolveOrThrow returns the NEW result untouched when softAssert is on`() {
        val client = FuranClient(testConfig().copy(softAssert = true), adapter = "test")
        try {
            val newResult = client.composeResult(
                runRow(status = RunStatus.NEW, autoApproved = null),
                RunStatus.NEW,
            )
            assertEquals(RunStatus.NEW, client.resolveOrThrow(newResult).status)
        } finally {
            client.close()
        }
    }

    @Test
    fun `resolveOrThrow still throws FuranAssertionException on a failure terminal`() {
        val client = FuranClient(testConfig(), adapter = "test")
        try {
            val failed = client.composeResult(
                runRow(status = RunStatus.FAILED),
                RunStatus.FAILED,
            )
            assertThrows<FuranAssertionException> { client.resolveOrThrow(failed) }
        } finally {
            client.close()
        }
    }

    @Test
    fun `resolveOrThrow returns a PASSED result without throwing`() {
        val client = FuranClient(testConfig(), adapter = "test")
        try {
            val passed = client.composeResult(
                runRow(status = RunStatus.PASSED, autoApproved = true),
                RunStatus.PASSED,
            )
            assertEquals(RunStatus.PASSED, client.resolveOrThrow(passed).status)
        } finally {
            client.close()
        }
    }
}
