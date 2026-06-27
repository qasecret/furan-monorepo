package io.furan.sdk.junit5

import io.furan.sdk.FuranSuiteException
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.dto.SuiteResult
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class AfterAllFailTest {
    @Test fun `suiteFailure returns exception when any run failed`() {
        val failing = SuiteResult(listOf(RunResult("a", RunStatus.PASSED, 1), RunResult("b", RunStatus.UNRESOLVED, 1)))
        assertEquals(true, failing.hasFailures)
        val ex: FuranSuiteException? = FuranExtension.suiteFailure(failing)
        assertNotNull(ex)
    }
    @Test fun `suiteFailure returns null when all passed`() {
        val passing = SuiteResult(listOf(RunResult("a", RunStatus.PASSED, 1)))
        assertEquals(false, passing.hasFailures)
        assertNull(FuranExtension.suiteFailure(passing))
    }
}
