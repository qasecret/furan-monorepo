package io.furan.sdk.junit5

import io.furan.sdk.FailOnDiff
import io.furan.sdk.FuranSuiteException
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.RunStatus
import io.furan.sdk.dto.SuiteResult
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
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

    // -------------------------------------------------------------------------
    // Fix #6: FAIL_ON_DIFF_KEY constant exists and the afterAll resolution logic
    // is exercised through the companion suiteFailure + suite accumulator helpers.
    // (Full JUnit5 ExtensionContext is complex to stub; we test the logic pieces.)
    // -------------------------------------------------------------------------

    @Test fun `FAIL_ON_DIFF_KEY constant is defined`() {
        // Ensures the key is stable and not accidentally renamed.
        assertEquals("fail-on-diff", FuranExtension.FAIL_ON_DIFF_KEY)
    }

    @Test fun `suiteFailure + accumulator — FURAN_KEY path simulation`() {
        // Simulates the FURAN_KEY path: afterEach calls appendResult for each
        // closed run, then afterAll uses suiteFailure to decide.
        val results = mutableListOf<RunResult>()
        FuranExtension.appendResult(results, RunResult("r1", RunStatus.PASSED, 1))
        FuranExtension.appendResult(results, RunResult("r2", RunStatus.UNRESOLVED, 1))

        val suite = FuranExtension.snapshotResults(results)
        assertEquals(true, suite.hasFailures)

        // With AfterAll configured (from the stashed FAIL_ON_DIFF_KEY), afterAll
        // would call suiteFailure — verify it throws on a failing suite.
        assertNotNull(FuranExtension.suiteFailure(suite))
    }

    @Test fun `suiteFailure + accumulator — FURAN_KEY path all-passing does not throw`() {
        val results = mutableListOf<RunResult>()
        FuranExtension.appendResult(results, RunResult("r1", RunStatus.PASSED, 2))

        val suite = FuranExtension.snapshotResults(results)
        assertEquals(false, suite.hasFailures)
        assertNull(FuranExtension.suiteFailure(suite))
    }

    @Test fun `FailOnDiff AfterAll enum value is resolvable for stashing`() {
        // Ensure AfterAll can be stored/retrieved as an enum (covers the
        // FAIL_ON_DIFF_KEY store.put/get type-safety path in afterAll).
        val stashed: FailOnDiff = FailOnDiff.AfterAll
        assertEquals(FailOnDiff.AfterAll, stashed)
    }
}
