package io.furan.sdk

import io.furan.sdk.dto.EyesTestResults
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult

/** Applitools `runner.getAllTestResults()` analog over [SuiteResult]. */
class EyesRunner {
    private val runs = mutableListOf<RunResult>()

    @Synchronized
    fun record(run: RunResult) {
        runs.add(run)
    }

    @Synchronized
    fun getAllTestResults(throwException: Boolean = true): List<EyesTestResults> {
        val suite = SuiteResult(runs.toList())
        if (throwException && suite.hasFailures) throw FuranSuiteException(suite)
        return suite.runs.map { EyesTestResults(it) }
    }
}
