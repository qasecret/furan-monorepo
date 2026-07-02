package io.furan.sdk.dto

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LoupeTestResultsTest {
    @Test fun `maps RunResult status to accessors`() {
        val passed = LoupeTestResults(RunResult("r1", RunStatus.PASSED, 2))
        assertTrue(passed.isPassed); assertFalse(passed.isDifferent); assertFalse(passed.isNew)
        assertEquals("r1", passed.runId); assertEquals(2, passed.checkpointCount)
        val unresolved = LoupeTestResults(RunResult("r2", RunStatus.UNRESOLVED, 1))
        assertTrue(unresolved.isDifferent); assertFalse(unresolved.isPassed)
        val failed = LoupeTestResults(RunResult("r3", RunStatus.FAILED, 1))
        assertTrue(failed.isDifferent)
        assertTrue(LoupeTestResults(RunResult("r4", RunStatus.NEW, 1)).isNew)
        assertTrue(LoupeTestResults(RunResult("r5", RunStatus.ABORTED, 1)).isAborted)
        assertTrue(LoupeTestResults(RunResult("r6", RunStatus.EMPTY, 0)).isEmpty)
    }
}
