package io.furan.sdk.appium

import io.appium.java_client.AppiumDriver
import io.furan.sdk.FuranCapture
import io.furan.sdk.FuranConfig
import io.furan.sdk.LoupeRunner
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.LoupeTestResults

/**
 * Loupe — Furan's compat facade for the Appium adapter
 * (compat contract — feature-conservative).
 * THIN wrapper: MUST NOT implement capture/diff/poll/approve/aggregate logic;
 * all behavior delegates to [FuranCapture]. Native innovation lives in [FuranAppium].
 *
 * @param runner optional [LoupeRunner] for suite-level aggregation. When provided,
 *   each [close] result is recorded on the runner so
 *   [LoupeRunner.getAllTestResults] returns the full suite.
 */
class Loupe(
    cfg: FuranConfig,
    driver: AppiumDriver,
    saveNewTests: Boolean = true,
    private val runner: LoupeRunner? = null,
) {
    val config: FuranConfig = cfg.copy(saveNewTests = saveNewTests)
    private val capture = FuranCapture(config, AppiumSpecDriver(driver), adapter = "appium-loupe")

    /**
     * Opens a test run named by [testName] alone. A test is a single named
     * thing that owns its checkpoints, so the row shows just the test name —
     * not an "app / test" path. [appName] is accepted for
     * source-compatibility; Furan models the application grouping as the
     * project, and the baseline identity is per-checkpoint (independent of the
     * run name), so [appName] is informational and does not change identity.
     */
    fun open(appName: String, testName: String) = capture.open(testName)

    fun check(
        name: String,
        options: CheckpointOptions = CheckpointOptions(),
        viewport: Viewport? = null,
    ): CheckpointSubmission = capture.snapshot(name, options, viewport)

    fun close(): LoupeTestResults? {
        val rr = capture.close() ?: return null
        runner?.record(rr)
        return LoupeTestResults(rr)
    }

    fun abort() = capture.abort()
}
