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
 *  - [AfterAll]: `close()` never throws (runs are collected silently). After all
 *    tests finish, the [io.furan.sdk.junit5.FuranExtension]'s `afterAll` hook
 *    inspects the aggregated [io.furan.sdk.dto.SuiteResult] and throws a single
 *    [FuranSuiteException] if any run ended in a failure state — mirroring
 *    Applitools' `runner.getAllTestResults(throwEx = true)` pattern.
 *
 * Configured via [FuranConfig.failOnDiff] or the `FURAN_FAIL_ON_DIFF`
 * environment variable.
 */
enum class FailOnDiff {
    /** close() returns RunResult without throwing. Default. */
    None,

    /** close() throws FuranDiffException if any checkpoint unresolved/failed. */
    AfterEach,

    /** Fails the suite once in afterAll via FuranExtension if any run failed. close() does not throw. */
    AfterAll,
}
