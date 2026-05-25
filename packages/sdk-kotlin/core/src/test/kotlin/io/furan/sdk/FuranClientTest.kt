package io.furan.sdk

import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.RunStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

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
}
