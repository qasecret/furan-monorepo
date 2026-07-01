package io.furan.sdk.dto

/**
 * Aggregate result for a JUnit5 suite (or any ordered collection of
 * Furan runs): one row per test, with derived counts + a printable summary.
 *
 * Construct directly with the list of [runs], or — when running inside
 * a `@FuranTest`-annotated JUnit5 class — read from the extension via
 * `FuranExtension.getSuiteResult(extensionContext)`.
 *
 * The derived counts iterate the [runs] list each time they're read.
 * That's fine for the suite sizes typical in CI (≤ a few hundred tests)
 * and avoids the cache-invalidation question if a caller mutates the
 * underlying list. If you need them computed once, snapshot the
 * properties locally.
 */
data class SuiteResult(
    val runs: List<RunResult>,
) {
    val total: Int get() = runs.size

    val passed: Int get() = runs.count { it.status == RunStatus.PASSED }

    val failed: Int get() = runs.count { it.status == RunStatus.FAILED }

    val unresolved: Int get() = runs.count { it.status == RunStatus.UNRESOLVED }

    val aborted: Int get() = runs.count { it.status == RunStatus.ABORTED }

    val empty: Int get() = runs.count { it.status == RunStatus.EMPTY }

    /** Total checkpoints captured across all runs in the suite. */
    val totalCheckpoints: Int get() = runs.sumOf { it.checkpointCount }

    /** True when every run terminated in [RunStatus.PASSED]. */
    val allPassed: Boolean get() = runs.isNotEmpty() && runs.all { it.status == RunStatus.PASSED }

    /**
     * True when at least one run terminated in a [RunStatus.isFailure]
     * state (UNRESOLVED, FAILED, or ABORTED).
     */
    val hasFailures: Boolean get() = runs.any { it.status.isFailure() }

    /**
     * Human-readable summary suitable for CI log lines. One header
     * line + one line per run:
     *
     * ```
     * Furan suite: 3 tests, 7 checkpoints — 2 passed, 1 failed, 0 unresolved, 0 aborted
     *   - 4b2a91c3 → passed
     *   - 90fe2143 → failed (3.42% diff)
     *   - aa118273 → passed
     * ```
     *
     * Run IDs are truncated to 8 chars to fit in a typical CI terminal
     * width. If you need the full IDs, iterate [runs] directly.
     */
    fun summary(): String = buildString {
        val tests = if (total == 1) "test" else "tests"
        val checkpoints = if (totalCheckpoints == 1) "checkpoint" else "checkpoints"
        appendLine("Furan suite: $total $tests, $totalCheckpoints $checkpoints — $passed passed, $failed failed, $unresolved unresolved, $aborted aborted")
        for (r in runs) {
            val statusName = r.status.name.lowercase()
            // Surface the worst checkpoint diff% on the run line when it's
            // non-zero — gives reviewers a "which run is loudest" signal at
            // a glance. Passed runs typically show 0% so we elide them.
            val worstDiff = r.checkpoints.mapNotNull { it.diffPercent }.maxOrNull()
            val diffStr = worstDiff?.takeIf { it > 0.0 }
                ?.let { " (${"%.2f".format(it)}% diff)" } ?: ""
            appendLine("  - ${r.runId.take(8)} → $statusName$diffStr")
        }
    }.trimEnd('\n')
}
