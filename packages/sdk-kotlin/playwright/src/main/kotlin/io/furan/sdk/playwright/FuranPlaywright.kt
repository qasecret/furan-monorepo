package io.furan.sdk.playwright

import com.microsoft.playwright.Page
import io.furan.sdk.FuranCapture
import io.furan.sdk.FuranConfig
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointResult
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.RunResult
import io.furan.sdk.dto.SuiteResult
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Furan's Playwright-Java adapter. Same open → snapshot → close lifecycle as
 * the Selenium [io.furan.sdk.selenium.Furan] adapter:
 *
 * ```kotlin
 * FuranPlaywright.use(FuranConfig.fromEnv(), page, "Checkout") { furan ->
 *     furan.snapshot("cart")
 * }
 * ```
 *
 * `browserName` is reported as `playwright-<type>` (chromium/firefox/webkit)
 * so each engine keeps a separate baseline against the same page URL.
 *
 * [io.furan.sdk.FailOnDiff.AfterEach] (set on [FuranConfig.failOnDiff]) causes
 * [close] to throw [io.furan.sdk.FuranDiffException] when the run ends with any
 * non-passing status.
 */
class FuranPlaywright(val config: FuranConfig, private val page: Page) {
    private val capture = FuranCapture(config, PlaywrightSpecDriver(page), adapter = "playwright")

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
         * FuranPlaywright.use(config, page, "MyTest") { furan ->
         *     furan.snapshot("step1")
         * }
         * ```
         */
        fun <R> use(config: FuranConfig, page: Page, testName: String, block: (FuranPlaywright) -> R): R {
            val furan = FuranPlaywright(config, page)
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

        @JvmStatic
        fun aggregateResults(runs: List<RunResult>): SuiteResult = FuranCapture.aggregateResults(runs)
    }
}
