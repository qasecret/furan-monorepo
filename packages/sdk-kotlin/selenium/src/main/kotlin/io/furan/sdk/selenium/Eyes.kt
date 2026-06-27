package io.furan.sdk.selenium

import io.furan.sdk.EyesRunner
import io.furan.sdk.FuranCapture
import io.furan.sdk.FuranConfig
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.EyesTestResults
import org.openqa.selenium.WebDriver

/**
 * Applitools Eyes compatibility facade (compat contract — feature-conservative).
 * THIN wrapper: MUST NOT implement capture/diff/poll/approve/aggregate logic;
 * all behavior delegates to [FuranCapture]. Native innovation lives in [Furan].
 *
 * @param runner optional [EyesRunner] for suite-level aggregation. When provided,
 *   each [close] result is recorded on the runner so
 *   [EyesRunner.getAllTestResults] returns the full suite.
 */
class Eyes(
    cfg: FuranConfig,
    driver: WebDriver,
    saveNewTests: Boolean = true,
    private val runner: EyesRunner? = null,
) {
    val config: FuranConfig = cfg.copy(saveNewTests = saveNewTests)
    private val capture = FuranCapture(config, SeleniumSpecDriver(driver), adapter = "selenium-eyes")

    /**
     * Opens a test run. The run name is composed as "appName / testName"
     * to match the Applitools Eyes convention.
     */
    fun open(appName: String, testName: String) = capture.open("$appName / $testName")

    fun check(
        name: String,
        options: CheckpointOptions = CheckpointOptions(),
        viewport: Viewport? = null,
    ): CheckpointSubmission = capture.snapshot(name, options, viewport)

    fun close(): EyesTestResults? {
        val rr = capture.close() ?: return null
        runner?.record(rr)
        return EyesTestResults(rr)
    }

    fun abort() = capture.abort()
}
