package io.furan.sdk.appium

import io.appium.java_client.AppiumDriver
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
 * Furan's Appium adapter for NATIVE mobile apps (Android / iOS). Same
 * open → snapshot → close lifecycle as the Selenium / Playwright adapters:
 *
 * ```kotlin
 * FuranAppium.use(FuranConfig.fromEnv(), driver, "Checkout") { furan ->
 *     furan.snapshot("cart")
 * }
 * ```
 *
 * Captures a full-screen native screenshot per snapshot (no DOM / element-map).
 * The browser label is the session's platform (`android` / `ios`), or its
 * browser for a browser session, so the platforms keep separate baselines
 * (see [AppiumSpecDriver.getDriverInfo]).
 *
 * [io.furan.sdk.FailOnDiff.AfterEach] (set on [FuranConfig.failOnDiff]) makes
 * [close] throw [io.furan.sdk.FuranDiffException] when the run ends non-passing.
 */
class FuranAppium(val config: FuranConfig, private val driver: AppiumDriver) {
    private val capture = FuranCapture(config, AppiumSpecDriver(driver), adapter = "appium")

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
         */
        fun <R> use(config: FuranConfig, driver: AppiumDriver, testName: String, block: (FuranAppium) -> R): R {
            val furan = FuranAppium(config, driver)
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
