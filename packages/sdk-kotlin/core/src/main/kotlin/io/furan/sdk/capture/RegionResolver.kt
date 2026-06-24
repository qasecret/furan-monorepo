package io.furan.sdk.capture

import io.furan.sdk.dto.Region
import io.furan.sdk.spec.Selector
import io.furan.sdk.spec.SpecDriver
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("io.furan.sdk.capture.RegionResolver")

/**
 * Resolve a [Region] carrying a [Region.selector] to its current bbox via
 * the SPI. A selector-less region passes through unchanged. A selector that
 * matches nothing (null element) or fails to read its rect (stale) falls
 * back to the region's declared geometry — Eyes-tolerant behavior.
 */
internal fun resolveRegion(driver: SpecDriver, region: Region): Region {
    val css = region.selector ?: return region
    val element = try {
        driver.findElement(Selector.Css(css))
    } catch (e: Exception) {
        log.warn("selector {} resolution failed ({}); using fallback geometry", css, e.message)
        return region
    }
    if (element == null) {
        log.warn(
            "selector {} did not match any element; using fallback geometry ({},{},{}x{})",
            css, region.x, region.y, region.width, region.height,
        )
        return region
    }
    return try {
        val rect = element.boundingRect()
        if (rect.width <= 0 || rect.height <= 0) {
            // A matched-but-unrendered element (display:none, detached, or
            // otherwise zero-area) reports a degenerate rect. Treat it like a
            // miss and keep the caller's declared geometry rather than
            // collapsing the region to 0x0 — preserves the Eyes-tolerant
            // fallback and avoids a zero-area crop downstream (PngCrop rejects
            // width/height <= 0).
            log.warn(
                "selector {} matched an unrendered element (rect {}x{}); using fallback geometry ({},{},{}x{})",
                css, rect.width, rect.height, region.x, region.y, region.width, region.height,
            )
            region
        } else {
            region.copy(
                x = rect.x.toDouble(),
                y = rect.y.toDouble(),
                width = rect.width.toDouble(),
                height = rect.height.toDouble(),
            )
        }
    } catch (e: Exception) {
        log.warn("selector {} resolution failed ({}); using fallback geometry", css, e.message)
        region
    }
}

/**
 * Capture only the bytes inside the element matched by [css] via the SPI's
 * element-direct screenshot. Throws when the selector misses — the caller
 * asked for that specific element, so there is no fallback. The miss throws
 * an engine-generic [IllegalStateException] (not a driver-specific type such
 * as Selenium's `NoSuchElementException`) so the engine stays driver-agnostic.
 */
internal fun captureElementScreenshot(driver: SpecDriver, css: String): ByteArray {
    val element = driver.findElement(Selector.Css(css))
        ?: error("no element matched selector $css for element-direct capture")
    return element.elementScreenshot()
}
