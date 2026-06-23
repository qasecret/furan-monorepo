package io.furan.sdk.capture

import io.furan.sdk.ELEMENT_BBOX_SCRIPT
import io.furan.sdk.Regions
import io.furan.sdk.Viewport
import io.furan.sdk.dto.CheckpointOptions
import io.furan.sdk.dto.Region
import io.furan.sdk.spec.Feature
import io.furan.sdk.spec.Size
import io.furan.sdk.spec.SpecDriver
import kotlinx.coroutines.delay
import org.slf4j.LoggerFactory

/**
 * Driver-agnostic capture orchestrator (was Furan.snapshotSuspend). Reads
 * SpecDriver.getDriverInfo() to choose the capture path:
 *  - web (JAVASCRIPT, not native): the full pipeline — viewport sizing,
 *    pre-capture hook, lazy-load, stable/stitch/element-direct/crop capture,
 *    selector-region resolution, DOM + element-map.
 *  - native (no JAVASCRIPT): one screenshot, native-rect region resolution,
 *    no DOM/element-map. (Phase-3 Appium-native path; exercised by tests.)
 *
 * The env tuple (browser/os/device) is filled from DriverInfo; the adapter
 * owns those labels.
 */
class CaptureEngine(private val driver: SpecDriver) {

    /**
     * Run the full capture pipeline for one checkpoint.
     *
     * @param name Checkpoint name forwarded by the adapter to
     *   `FuranClient.createScreenshot`; intentionally absent from
     *   [CaptureResult] because the result is a pixel/DOM carrier only.
     */
    suspend fun capture(name: String, options: CheckpointOptions, viewport: Viewport): CaptureResult {
        val info = driver.getDriverInfo()
        val viewportLabel = "${viewport.width}x${viewport.height}"

        if (Feature.RESIZE_VIEWPORT in info.features) {
            driver.setViewportSize(Size(viewport.width, viewport.height))
        }

        val jsCapable = !info.isNative && Feature.JAVASCRIPT in info.features

        val pngBytes: ByteArray
        val domHtml: String?
        val elementMapJson: String?

        if (!jsCapable) {
            pngBytes = driver.takeScreenshot()
            domHtml = null
            elementMapJson = null
        } else {
            options.beforeCaptureScreenshot?.let { driver.executeScript(it) }
            options.lazyLoad?.let { runLazyLoadScroll(driver, it) }
            if (options.waitBeforeCaptureMs > 0) delay(options.waitBeforeCaptureMs)

            val captureRegion = options.region
            val captureSelector = captureRegion?.selector
            if (options.fully && options.matchTimeoutMs > 0) warnMatchTimeoutIgnoredInFullyMode()

            pngBytes = when {
                options.fully && captureRegion != null -> {
                    val stitched = withHideFixed(options.hideFixedElements) {
                        captureFullyPage(driver, viewportWidth = viewport.width, viewportHeight = viewport.height)
                    }
                    cropPng(stitched, resolveRegion(driver, captureRegion))
                }
                options.fully -> withHideFixed(options.hideFixedElements) {
                    captureFullyPage(driver, viewportWidth = viewport.width, viewportHeight = viewport.height)
                }
                captureRegion != null && captureSelector != null ->
                    captureElementScreenshot(driver, captureSelector)
                captureRegion != null ->
                    cropPng(captureStableScreenshot(driver, options.matchTimeoutMs), resolveRegion(driver, captureRegion))
                else -> captureStableScreenshot(driver, options.matchTimeoutMs)
            }

            domHtml = resolveDomPayload(
                override = options.domHtml,
                sendDom = options.sendDom,
                capture = { captureDom(driver) },
            )
            elementMapJson = options.elementMapJson ?: captureElementBboxes(driver)
        }

        val ignore = augmentIgnoreRegions(options.ignoreRegions, options.ignoreCaret)
            .map { resolveRegion(driver, it) }
        val layout = options.layoutRegions.map { resolveRegion(driver, it) }
        val content = options.contentRegions.map { resolveRegion(driver, it) }

        return CaptureResult(
            pngBytes = pngBytes,
            viewport = viewportLabel,
            browser = info.browserName,
            os = info.platformName,
            device = info.deviceName,
            regions = Regions(
                ignore = ignore,
                layout = layout,
                floating = options.floatingRegions,
                content = content,
                accessibility = options.accessibilityRegions,
            ),
            domHtml = domHtml,
            elementMapJson = elementMapJson,
        )
    }

    /** Inject the hide-fixed style (if any), run [block], restore in finally. */
    private suspend fun <R> withHideFixed(selectors: List<String>, block: suspend () -> R): R {
        if (selectors.isEmpty()) return block()
        injectFixedElementHider(driver, selectors)
        try {
            return block()
        } finally {
            runCatching { removeFixedElementHider(driver) }
        }
    }

    companion object {
        private val log = LoggerFactory.getLogger(CaptureEngine::class.java)
        private const val MAX_ELEMENT_MAP_BYTES = 1_000_000

        /** Selector-anchored ignore region auto-appended when ignoreCaret = true. */
        internal val CARET_FOCUS_REGION: Region =
            Region.bySelector("input:focus, textarea:focus, [contenteditable]:focus")

        internal fun augmentIgnoreRegions(ignoreRegions: List<Region>, ignoreCaret: Boolean): List<Region> =
            if (ignoreCaret) ignoreRegions + CARET_FOCUS_REGION else ignoreRegions

        /** Best-effort element-map capture; drops silently on any failure. */
        internal fun captureElementBboxes(driver: SpecDriver): String? = try {
            val raw = driver.executeScript(ELEMENT_BBOX_SCRIPT) as? String
            when {
                raw == null -> null
                raw.length > MAX_ELEMENT_MAP_BYTES -> {
                    log.warn("Element map {} bytes exceeds {}; dropping", raw.length, MAX_ELEMENT_MAP_BYTES)
                    null
                }
                else -> raw
            }
        } catch (e: Exception) {
            log.warn("Element bbox capture failed; continuing without it", e)
            null
        }
    }
}
