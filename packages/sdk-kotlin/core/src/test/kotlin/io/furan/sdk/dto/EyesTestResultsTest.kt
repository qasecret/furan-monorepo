package io.furan.sdk.dto

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EyesTestResultsTest {
    @Test fun `maps RunResult status to Applitools accessors`() {
        val passed = EyesTestResults(RunResult("r1", RunStatus.PASSED, 2))
        assertTrue(passed.isPassed); assertFalse(passed.isDifferent); assertFalse(passed.isNew)
        assertEquals("r1", passed.runId); assertEquals(2, passed.checkpointCount)
        val unresolved = EyesTestResults(RunResult("r2", RunStatus.UNRESOLVED, 1))
        assertTrue(unresolved.isDifferent); assertFalse(unresolved.isPassed)
        val failed = EyesTestResults(RunResult("r3", RunStatus.FAILED, 1))
        assertTrue(failed.isDifferent)
        assertTrue(EyesTestResults(RunResult("r4", RunStatus.NEW, 1)).isNew)
        assertTrue(EyesTestResults(RunResult("r5", RunStatus.ABORTED, 1)).isAborted)
        assertTrue(EyesTestResults(RunResult("r6", RunStatus.EMPTY, 0)).isEmpty)
    }
}
