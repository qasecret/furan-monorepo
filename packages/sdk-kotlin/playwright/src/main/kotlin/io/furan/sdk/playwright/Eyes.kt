package io.furan.sdk.playwright

import com.microsoft.playwright.Page
import io.furan.sdk.FuranCapture
import io.furan.sdk.FuranConfig
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.CheckpointSubmission
import io.furan.sdk.dto.EyesTestResults

/**
 * Applitools Eyes compatibility facade for the Playwright adapter
 * (compat contract — feature-conservative).
 * THIN wrapper: MUST NOT implement capture/diff/poll/approve/aggregate logic;
 * all behavior delegates to [FuranCapture]. Native innovation lives in [FuranPlaywright].
 */
class Eyes(
    cfg: FuranConfig,
    page: Page,
    saveNewTests: Boolean = true,
) {
    val config: FuranConfig = cfg.copy(saveNewTests = saveNewTests)
    private val capture = FuranCapture(config, PlaywrightSpecDriver(page), adapter = "playwright-eyes")

    fun open(appName: String, testName: String) = capture.open("$appName / $testName")

    fun check(
        name: String,
        options: CheckpointOptions = CheckpointOptions(),
        viewport: Viewport? = null,
    ): CheckpointSubmission = capture.snapshot(name, options, viewport)

    fun close(): EyesTestResults? = capture.close()?.let { EyesTestResults(it) }

    fun abort() = capture.abort()
}
