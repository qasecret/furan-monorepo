package io.furan.sdk

/**
 * Ends the open run after the test block threw [error]. Every adapter's
 * `use { }` and the JUnit 5 extension call this instead of aborting outright.
 *
 * A [FuranAssertionException] or [FuranNoBaselineException] is the verdict
 * `snapshotAndAwait` reports on purpose: the screenshots are uploaded and the
 * run holds a result a reviewer acts on (approve the change, or save the first
 * baseline). Aborting would make that run unreviewable, so the run is
 * completed instead. Any other error means the test did not finish, and the
 * run is aborted.
 *
 * Neither call may replace [error]: their own failures are swallowed, so the
 * test reports the original exception.
 */
fun endRunAfterFailure(error: Throwable, close: () -> Unit, abort: () -> Unit) {
    if (error is FuranAssertionException || error is FuranNoBaselineException) {
        runCatching { close() }
    } else {
        runCatching { abort() }
    }
}
