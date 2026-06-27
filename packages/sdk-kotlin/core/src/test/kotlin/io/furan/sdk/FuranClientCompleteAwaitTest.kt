package io.furan.sdk

import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.time.Duration.Companion.seconds

class FuranClientCompleteAwaitTest {

    private fun testConfig() = FuranConfig(
        apiUrl = "http://127.0.0.1:1",
        apiToken = "furan_pat_test_abcdefghijklmnopqrst",
        projectId = "00000000-0000-0000-0000-000000000000",
        telemetryEnabled = false,
        pollTimeoutSeconds = 5,
        pollIntervalSeconds = 1,
    )

    /**
     * Test double that stubs [completeRun] and [getRun] without hitting the network.
     * Pops responses from queues in order.
     */
    private class StubClient(
        config: FuranConfig,
        private val completeResponses: ArrayDeque<RunResult>,
        private val getRunResponses: ArrayDeque<RunResponse>,
    ) : FuranClient(config, adapter = "test") {
        var completeCalls = 0
        var getRunCalls = 0

        override suspend fun completeRun(runId: String): RunResult {
            completeCalls++
            return completeResponses.removeFirst()
        }

        override suspend fun getRun(runId: String): RunResponse {
            getRunCalls++
            return getRunResponses.removeFirst()
        }
    }

    @Test
    fun `completeAndAwaitRun polls past running until a terminal status`() = runBlocking {
        val config = testConfig()

        // POST complete returns RUNNING (non-terminal) → triggers polling
        val completeResult = RunResult(runId = "r1", status = RunStatus.RUNNING, checkpointCount = 3)
        // Three GETs: running, running, unresolved (terminal)
        val getResponses = ArrayDeque(
            listOf(
                RunResponse(id = "r1", projectId = "proj", buildId = "b1", status = RunStatus.RUNNING),
                RunResponse(id = "r1", projectId = "proj", buildId = "b1", status = RunStatus.RUNNING),
                RunResponse(
                    id = "r1",
                    projectId = "proj",
                    buildId = "b1",
                    status = RunStatus.UNRESOLVED,
                ),
            ),
        )

        val client = StubClient(
            config = config,
            completeResponses = ArrayDeque(listOf(completeResult)),
            getRunResponses = getResponses,
        )
        try {
            val result = client.completeAndAwaitRun("r1", timeout = 10.seconds)
            assertEquals(RunStatus.UNRESOLVED, result.status)
            assertEquals("r1", result.runId)
            // checkpointCount propagated from the completeRun result
            assertEquals(3, result.checkpointCount)
            assertEquals(1, client.completeCalls)
            // Polled at least until the third response
            assertEquals(3, client.getRunCalls)
        } finally {
            client.close()
        }
    }

    @Test
    fun `completeAndAwaitRun returns immediately when completeRun returns a terminal status`() =
        runBlocking {
            val config = testConfig()
            val completeResult =
                RunResult(runId = "r2", status = RunStatus.PASSED, checkpointCount = 1)
            val client = StubClient(
                config = config,
                completeResponses = ArrayDeque(listOf(completeResult)),
                getRunResponses = ArrayDeque(), // no polling needed
            )
            try {
                val result = client.completeAndAwaitRun("r2", timeout = 5.seconds)
                assertEquals(RunStatus.PASSED, result.status)
                assertEquals("r2", result.runId)
                // No polling when completeRun already returns terminal
                assertEquals(0, client.getRunCalls)
            } finally {
                client.close()
            }
        }

    @Test
    fun `completeAndAwaitRun returns immediately when completeRun returns NEW`() = runBlocking {
        val config = testConfig()
        val completeResult = RunResult(runId = "r3", status = RunStatus.NEW, checkpointCount = 0)
        val client = StubClient(
            config = config,
            completeResponses = ArrayDeque(listOf(completeResult)),
            getRunResponses = ArrayDeque(), // no polling
        )
        try {
            val result = client.completeAndAwaitRun("r3", timeout = 5.seconds)
            assertEquals(RunStatus.NEW, result.status)
            assertEquals("r3", result.runId)
            assertEquals(0, client.getRunCalls)
        } finally {
            client.close()
        }
    }

    @Test
    fun `completeAndAwaitRun throws FuranTimeoutException when polling never reaches terminal`() =
        runBlocking {
            val config = testConfig()
            val completeResult =
                RunResult(runId = "r4", status = RunStatus.RUNNING, checkpointCount = 2)

            // All polls return RUNNING — never terminal
            val getResponses = ArrayDeque(
                (1..20).map {
                    RunResponse(
                        id = "r4",
                        projectId = "proj",
                        buildId = "b1",
                        status = RunStatus.RUNNING,
                    )
                },
            )

            val client = StubClient(
                config = config,
                completeResponses = ArrayDeque(listOf(completeResult)),
                getRunResponses = getResponses,
            )
            try {
                val ex = assertThrows<FuranTimeoutException> {
                    runBlocking {
                        client.completeAndAwaitRun("r4", timeout = 2.seconds)
                    }
                }
                assertEquals("r4", ex.runId)
                assertEquals(RunStatus.RUNNING, ex.lastStatus)
            } finally {
                client.close()
            }
        }
}
