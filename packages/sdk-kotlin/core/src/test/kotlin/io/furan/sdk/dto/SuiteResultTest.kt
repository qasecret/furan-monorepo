package io.furan.sdk.dto

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SuiteResultTest {

    @Test
    fun `empty suite — derived counts are all zero and allPassed is false`() {
        val s = SuiteResult(emptyList())
        assertEquals(0, s.total)
        assertEquals(0, s.passed)
        assertEquals(0, s.failed)
        assertEquals(0, s.unresolved)
        assertEquals(0, s.aborted)
        assertEquals(0, s.totalCheckpoints)
        // Vacuous "all passed" is intentionally false — no runs means
        // there's nothing to assert on, and a CI step that reads
        // allPassed should treat the empty case as a config error
        // rather than green-by-default.
        assertFalse(s.allPassed)
        assertFalse(s.hasFailures)
    }

    @Test
    fun `mixed statuses — counts each terminal state separately`() {
        val s = SuiteResult(
            listOf(
                run("r1", RunStatus.PASSED, checkpointCount = 3),
                run("r2", RunStatus.FAILED, checkpointCount = 2),
                run("r3", RunStatus.UNRESOLVED, checkpointCount = 1),
                run("r4", RunStatus.ABORTED, checkpointCount = 0),
                run("r5", RunStatus.PASSED, checkpointCount = 4),
                run("r6", RunStatus.EMPTY, checkpointCount = 0),
            ),
        )
        assertEquals(6, s.total)
        assertEquals(2, s.passed)
        assertEquals(1, s.failed)
        assertEquals(1, s.unresolved)
        assertEquals(1, s.aborted)
        assertEquals(1, s.empty)
        assertEquals(10, s.totalCheckpoints)
        assertFalse(s.allPassed)
        assertTrue(s.hasFailures)
    }

    @Test
    fun `all-passed suite — allPassed=true, hasFailures=false`() {
        val s = SuiteResult(
            listOf(
                run("r1", RunStatus.PASSED, checkpointCount = 1),
                run("r2", RunStatus.PASSED, checkpointCount = 2),
            ),
        )
        assertTrue(s.allPassed)
        assertFalse(s.hasFailures)
    }

    @Test
    fun `summary — formats header + one line per run`() {
        val s = SuiteResult(
            listOf(
                run("4b2a91c3-abcd-1234-5678-9abcdef01234", RunStatus.PASSED, checkpointCount = 2),
                run(
                    "90fe2143-abcd-1234-5678-9abcdef01234",
                    RunStatus.FAILED,
                    checkpointCount = 1,
                    checkpoints = listOf(
                        CheckpointResult(
                            checkpointId = "cp1",
                            name = "page",
                            status = RunStatus.FAILED,
                            diffPercent = 3.42,
                        ),
                    ),
                ),
            ),
        )
        val out = s.summary()
        // Header line.
        assertTrue(out.contains("Furan suite: 2 tests, 3 checkpoints"))
        assertTrue(out.contains("1 passed"))
        assertTrue(out.contains("1 failed"))
        // Per-run lines: truncated runId + status + diff%.
        assertTrue(out.contains("4b2a91c3 → passed"))
        assertTrue(out.contains("90fe2143 → failed (3.42% diff)"))
        // No trailing blank lines.
        assertFalse(out.endsWith("\n\n"))
    }

    @Test
    fun `summary — singular forms for 1 test 1 checkpoint`() {
        val s = SuiteResult(
            listOf(run("solo", RunStatus.PASSED, checkpointCount = 1)),
        )
        val out = s.summary()
        assertTrue(out.contains("1 test, 1 checkpoint"))
    }

    @Test
    fun `summary — passed run with zero-diff checkpoint omits diff hint`() {
        val s = SuiteResult(
            listOf(
                run(
                    "passed-run",
                    RunStatus.PASSED,
                    checkpointCount = 1,
                    checkpoints = listOf(
                        CheckpointResult(
                            checkpointId = "cp1",
                            name = "page",
                            status = RunStatus.PASSED,
                            diffPercent = 0.0,
                        ),
                    ),
                ),
            ),
        )
        val out = s.summary()
        // No "(0.00% diff)" noise on the run line.
        assertFalse(out.contains("0.00%"))
        assertTrue(out.contains("→ passed"))
    }
}

private fun run(
    runId: String,
    status: RunStatus,
    checkpointCount: Int = 0,
    checkpoints: List<CheckpointResult> = emptyList(),
) = RunResult(
    runId = runId,
    status = status,
    checkpointCount = checkpointCount,
    checkpoints = checkpoints,
)
