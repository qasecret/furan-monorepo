package io.furan.sdk.selenium

import io.furan.sdk.FuranCapture
import io.furan.sdk.FuranConfig
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointResult
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult
import org.openqa.selenium.WebDriver
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Public API for Furan's Selenium-Java adapter (SDK 2.0.0, ADR-038).
 *
 * Explicit lifecycle — callers must open before snapshotting:
 *
 * ```kotlin
 * val furan = Furan(FuranConfig.fromEnv(), driver)
 * furan.open("GoogleSearchFlow")
 * furan.snapshot("HomePage")
 * furan.snapshot("ResultsPage")
 * val result = furan.close()   // returns RunResult?
 * ```
 *
 * On test failure:
 * ```kotlin
 * try {
 *     furan.open("MyTest")
 *     furan.snapshot("step1")
 *     // ... test logic
 *     furan.close()
 * } catch (e: Throwable) {
 *     furan.abort()
 *     throw e
 * }
 * ```
 *
 * Or use the convenience [Furan.use] companion:
 * ```kotlin
 * Furan.use(config, driver, "MyTest") { furan ->
 *     furan.snapshot("step1")
 * }
 * ```
 *
 * [io.furan.sdk.FailOnDiff.AfterEach] (set on [FuranConfig.failOnDiff]) causes [close]
 * to throw [io.furan.sdk.FuranDiffException] when the run ends with any non-passing status.
 */
class Furan(
    val config: FuranConfig,
    private val driver: WebDriver,
) {
    private val capture = FuranCapture(config, SeleniumSpecDriver(driver), adapter = "selenium")

    fun open(testName: String) = capture.open(testName)

    fun snapshot(
        name: String,
        options: CheckpointOptions = CheckpointOptions(),
        viewport: Viewport? = null,
    ): CheckpointSubmission = capture.snapshot(name, options, viewport)

    fun snapshotAndAwait(
        name: String,
        options: CheckpointOptions = CheckpointOptions(),
        viewport: Viewport? = null,
        timeout: Duration = config.pollTimeoutSeconds.seconds,
    ): CheckpointResult = capture.snapshotAndAwait(name, options, viewport, timeout)

    fun close(): RunResult? = capture.close()

    fun abort() = capture.abort()

    companion object {
        /**
         * Convenience factory: opens a run, runs [block], closes on success,
         * aborts on exception. Returns the block's result.
         *
         * ```kotlin
         * val result = Furan.use(config, driver, "MyTest") { furan ->
         *     furan.snapshot("step1")
         *     furan.close()
         * }
         * ```
         */
        fun <R> use(
            config: FuranConfig,
            driver: WebDriver,
            testName: String,
            block: (Furan) -> R,
        ): R {
            val furan = Furan(config, driver)
            return try {
                furan.open(testName)
                val result = block(furan)
                furan.close()
                result
            } catch (e: Throwable) {
                runCatching { furan.abort() }
                throw e
            }
        }

        /**
         * Tier 1.5 (Eyes-parity `runner.getAllTestResults`): wrap a
         * collection of completed [RunResult]s in a [SuiteResult] for
         * uniform CI reporting (derived counts, pass/fail summary, etc).
         *
         * For tests using [io.furan.sdk.selenium.junit5.FuranExtension], prefer
         * `FuranExtension.getSuiteResult(extensionContext)` which auto-
         * collects every [close] result from the suite. This factory is
         * for the manual case (tests not on the extension path) and for
         * Java callers that want a single static entry point.
         */
        @JvmStatic
        fun aggregateResults(runs: List<RunResult>): SuiteResult = FuranCapture.aggregateResults(runs)
    }
}
