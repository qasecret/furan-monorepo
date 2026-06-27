package io.furan.sdk

import io.furan.sdk.dto.LoupeTestResults
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Compatibility contract: Eyes Compatibility Level v1 (Applitools Eyes SDK 5.x).
 * Maps each Furan run_status to its Applitools meaning + passing verdict.
 *
 * Note: the close()-level verdicts — empty=pass+warn, new=manual-fail-unless-saveNewTests,
 * unresolved/failed/aborted=fail — are covered behaviourally in FuranCaptureCloseTest +
 * SaveNewTestsTest; this file pins the status→Eyes-accessor mapping.
 */
class StatusCompatibilityMatrixTest {
    private fun view(s: RunStatus) = LoupeTestResults(RunResult("r", s, 1))

    @Test fun `passed maps to Passed and is passing`() {
        assertTrue(view(RunStatus.PASSED).isPassed)
    }
    @Test fun `unresolved maps to Unresolved (different), non-passing`() {
        val v = view(RunStatus.UNRESOLVED); assertTrue(v.isDifferent); assertFalse(v.isPassed)
    }
    @Test fun `failed maps to Failed (different), non-passing`() {
        val v = view(RunStatus.FAILED); assertTrue(v.isDifferent); assertFalse(v.isPassed)
    }
    @Test fun `aborted maps to Aborted, non-passing`() {
        val v = view(RunStatus.ABORTED); assertTrue(v.isAborted); assertFalse(v.isPassed)
    }
    @Test fun `empty maps to Empty (neutral), non-passing-status but treated as pass by close`() {
        val v = view(RunStatus.EMPTY); assertTrue(v.isEmpty); assertFalse(v.isPassed)
    }
    @Test fun `new maps to New, passing-is-configurable via saveNewTests`() {
        assertTrue(view(RunStatus.NEW).isNew)
    }
}
