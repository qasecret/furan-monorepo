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
 *  - [AfterAll]: `close()` swallows the failure; a JVM shutdown hook throws
 *    [FuranDiffException] at exit so the suite fails after all tests run.
 *    Useful for "fail the suite but complete all tests" CI patterns.
 *
 * Configured via [FuranConfig.failOnDiff] or the `FURAN_FAIL_ON_DIFF`
 * environment variable.
 */
enum class FailOnDiff {
    /** close() returns RunResult without throwing. Default. */
    None,

    /** close() throws FuranDiffException if any checkpoint unresolved/failed. */
    AfterEach,

    /** close() swallows; JVM shutdown hook throws at exit. */
    AfterAll,
}
