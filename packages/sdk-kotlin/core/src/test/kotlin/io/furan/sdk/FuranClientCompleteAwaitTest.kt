package io.furan.sdk

import io.furan.sdk.dto.RunResponse
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Test
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
    fun `completeAndAwaitRun polls past running until a terminal status`() = runTest {
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
        runTest {
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
    fun `completeAndAwaitRun returns immediately when completeRun returns NEW`() = runTest {
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

            // All polls return RUNNING — never terminal.
            // timeout = 1.1s so only one real ~1s delay fires before the wall-clock
            // check trips; the 20-entry queue is never exhausted.
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
                val ex = runCatching {
                    client.completeAndAwaitRun("r4", timeout = 1.1.seconds)
                }.exceptionOrNull()
                assertInstanceOf(FuranTimeoutException::class.java, ex)
                assertEquals("r4", (ex as FuranTimeoutException).runId)
                assertEquals(RunStatus.RUNNING, ex.lastStatus)
            } finally {
                client.close()
            }
        }

    @Test
    fun `completeAndAwaitRun polls at least once when interval equals timeout (#9 edge)`() = runTest {
        // FuranConfig.init allows pollIntervalSeconds == pollTimeoutSeconds.
        // The old bottom-delay loop degenerated to "one poll then immediate
        // timeout"; the fix guarantees the first getRun runs and a terminal
        // observed on that first poll is returned (not lost to a leading delay
        // or a wasted trailing delay).
        val config = FuranConfig(
            apiUrl = "http://127.0.0.1:1",
            apiToken = "furan_pat_test_abcdefghijklmnopqrst",
            projectId = "00000000-0000-0000-0000-000000000000",
            telemetryEnabled = false,
            pollTimeoutSeconds = 2,
            pollIntervalSeconds = 2, // interval == timeout
        )
        val completeResult = RunResult(runId = "r6", status = RunStatus.RUNNING, checkpointCount = 1)
        // First (and only) poll already terminal — must be returned.
        val getResponses = ArrayDeque(
            listOf(
                RunResponse(id = "r6", projectId = "proj", buildId = "b1", status = RunStatus.PASSED),
            ),
        )
        val client = StubClient(
            config = config,
            completeResponses = ArrayDeque(listOf(completeResult)),
            getRunResponses = getResponses,
        )
        try {
            val result = client.completeAndAwaitRun("r6", timeout = 2.seconds)
            assertEquals(RunStatus.PASSED, result.status)
            assertEquals("r6", result.runId)
            // At least one poll happened (the first getRun was not starved).
            assertEquals(1, client.getRunCalls)
        } finally {
            client.close()
        }
    }

    @Test
    fun `completeAndAwaitRun returns NEW when poll returns NEW before terminal`() = runTest {
        val config = testConfig()
        // completeRun returns RUNNING (non-terminal) → triggers polling
        val completeResult = RunResult(runId = "r5", status = RunStatus.RUNNING, checkpointCount = 2)
        // Poll once: RUNNING, then NEW — should return immediately with NEW
        val getResponses = ArrayDeque(
            listOf(
                RunResponse(id = "r5", projectId = "proj", buildId = "b1", status = RunStatus.RUNNING),
                RunResponse(id = "r5", projectId = "proj", buildId = "b1", status = RunStatus.NEW),
            ),
        )

        val client = StubClient(
            config = config,
            completeResponses = ArrayDeque(listOf(completeResult)),
            getRunResponses = getResponses,
        )
        try {
            val result = client.completeAndAwaitRun("r5", timeout = 10.seconds)
            assertEquals(RunStatus.NEW, result.status)
            assertEquals("r5", result.runId)
            // checkpointCount propagated from completeRun (fix #1)
            assertEquals(2, result.checkpointCount)
            assertEquals(1, client.completeCalls)
            assertEquals(2, client.getRunCalls)
        } finally {
            client.close()
        }
    }
}
