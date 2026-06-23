package io.furan.sdk

/**
 * Controls whether [io.furan.sdk.selenium.Furan.close] throws
 * [FuranDiffException] when the run ends with unresolved or failed
 * checkpoints.
 *
 *  - [None] (default): `close()` always returns [io.furan.sdk.dto.RunResult]
 *    without throwing. The caller inspects `result.status` explicitly.
 *  - [AfterEach]: `close()` throws [FuranDiffException] if the run's status
 *    is not [io.furan.sdk.dto.RunStatus.PASSED] (i.e., any unresolved or
 *    failed checkpoint causes the test to fail immediately).
 *  - [AfterAll]: **not yet implemented** — currently behaves like [None]
 *    (`close()` does not throw). The intended "fail the suite after all tests
 *    run" deferral is not wired up; use `aggregateResults` for a suite-level
 *    pass/fail summary in the meantime.
 *
 * Configured via [FuranConfig.failOnDiff] or the `FURAN_FAIL_ON_DIFF`
 * environment variable.
 */
enum class FailOnDiff {
    /** close() returns RunResult without throwing. Default. */
    None,

    /** close() throws FuranDiffException if any checkpoint unresolved/failed. */
    AfterEach,

    /** NOT YET IMPLEMENTED — currently behaves like [None]. Use aggregateResults for suite-level failure. */
    AfterAll,
}
