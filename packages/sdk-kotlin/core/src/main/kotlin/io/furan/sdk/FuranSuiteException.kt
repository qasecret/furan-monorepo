package io.furan.sdk

import io.furan.sdk.dto.SuiteResult

/** Raised at suite end when FailOnDiff.AfterAll and any run failed. */
class FuranSuiteException(val suite: SuiteResult) :
    FuranException("Visual suite failed: ${suite.summary()}")
