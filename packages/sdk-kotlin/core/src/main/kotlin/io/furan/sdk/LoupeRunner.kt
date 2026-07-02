package io.furan.sdk

import io.furan.sdk.dto.LoupeTestResults
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult

/** Suite-result aggregator over [SuiteResult]. */
class LoupeRunner {
    private val runs = mutableListOf<RunResult>()

    @Synchronized
    fun record(run: RunResult) {
        runs.add(run)
    }

    @Synchronized
    fun getAllTestResults(throwException: Boolean = true): List<LoupeTestResults> {
        val suite = SuiteResult(runs.toList())
        if (throwException && suite.hasFailures) throw FuranSuiteException(suite)
        return suite.runs.map { LoupeTestResults(it) }
    }
}
